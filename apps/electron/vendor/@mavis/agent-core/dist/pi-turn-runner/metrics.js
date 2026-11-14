/**
 * pi-turn-runner metrics (MR1) — emit the `pi_*` metric family for the
 * agent-core inner loop through the optionally injected `MetricsClient`.
 *
 * Design constraints:
 * - Noop-safe: no client → the internal client is a noop and assembly
 *   fingerprinting stays disabled.
 * - Zero behavior change: every observation point is wrapped so that a
 *   throwing client or a bug in the recorder can never break the turn.
 * - Bare metric names (no `local_runtime_` prefix — the reporting layer
 *   rejects prefixed names since MR0); labels are low-cardinality only.
 */
import { createBusyTimeAccumulator, incrementMetric, observeMetric, } from '@mavis/shared/local-runtime-logging/metric-registry';
import { normalizeLLMError, toLLMFailureErrorKind, toLLMMetricErrorKind, } from '@mavis/shared/llm-error-classifier';
import { classifyLocalResourceError } from '@mavis/shared/local-resource-errors';
import { isLLMCallPreempted } from './llm-preemption.js';
import { LLMRequestStoppedError, } from './llm-retry.js';
import { normalizeAbortSource, } from './types.js';
import { isEffectiveOutputEvent, managedTransportMs, parseGatewayServerTiming, readTurnRequestPhase, responseHeader, turnPrepareStages, } from './turn-timing.js';
import { createToolContextHistogramBucketsByName, measureToolArguments, measureToolContext, measureToolResult, } from './tool-context-size.js';
import { fingerprintAssembly } from './assembly-fingerprint.js';
const LARGE_TOOL_IO_TOKEN_THRESHOLD = 8_000;
const MAX_ASSEMBLY_FINGERPRINT_BASELINES = 2_048;
const MAX_LLM_REQUEST_GAP_BASELINES = 2_048;
const MAX_TOOL_OPERATION_VALUES = 128;
const MAX_TOOL_OPERATION_VALUE_LENGTH = 64;
function shippedRequestLabels(labels) {
    return { provider: labels.provider, model: labels.model, caller: labels.caller };
}
/**
 * A host without registry metrics (the cloud runtime) reports these metrics
 * with the label set they shipped with before the registry, which has no
 * `route`; the registry's typed labels would add it.
 */
function countShippedShape(client, name, labels) {
    swallow(() => client.counter(name, 1, labels));
}
function observeShippedShape(client, name, value, labels) {
    swallow(() => client.histogram(name, value, labels));
}
/** The phases whose requests the first-output metrics measure; compaction is not one. */
function measuredPhase(phase) {
    return phase === 'initial' || phase === 'iteration';
}
const FIRST_TOKEN_EVENT_TYPES = new Set([
    'text_start',
    'text_delta',
    'thinking_start',
    'thinking_delta',
    'toolcall_start',
    'toolcall_delta',
]);
const noopMetricsClient = {
    counter() { },
    gauge() { },
    histogram() { },
};
export function newPiTurnMetrics(client, nowMs, onLLMRequestFailure, observeLLMRequest, registryMetrics = false) {
    return new PiTurnMetrics(client ?? noopMetricsClient, nowMs, client !== undefined, onLLMRequestFailure, observeLLMRequest, registryMetrics);
}
export function createPiTurnHistogramBucketsByName() {
    return createToolContextHistogramBucketsByName();
}
/**
 * Record the final outcome of one logical LLM call without conflating it with
 * its physical retry attempts. All labels are fixed-cardinality framework
 * classifications.
 */
export function recordPiLLMCallMetrics(client, caller, event, route = 'unknown', agentKind) {
    if (!client)
        return;
    const baseLabels = {
        provider: event.provider,
        model: event.model,
        caller,
        ...agentKindLabels(agentKind),
        scope: event.scope,
    };
    incrementMetric(client, 'pi_llm_logical_call_total', 1, {
        ...baseLabels,
        route,
        outcome: event.final.outcome,
        errorKind: event.final.errorKind,
        retryTriggered: event.retryTriggered ? 'true' : 'false',
    });
    recordRetryEpisode(client, baseLabels, event, event.final.outcome);
}
/**
 * {@link recordPiLLMCallMetrics} for a host without registry metrics: the
 * label set and error kinds the call metrics shipped with, no `route` and no
 * local resource kinds.
 */
function recordShippedLLMCallMetrics(client, caller, event, agentKind) {
    const final = event.legacyFinal ?? event.final;
    const baseLabels = {
        provider: event.provider,
        model: event.model,
        caller,
        ...agentKindLabels(agentKind),
        scope: event.scope,
    };
    countShippedShape(client, 'pi_llm_logical_call_total', {
        ...baseLabels,
        outcome: final.outcome,
        errorKind: final.errorKind,
        retryTriggered: event.retryTriggered ? 'true' : 'false',
    });
    recordRetryEpisode(client, baseLabels, event, final.outcome);
}
function recordRetryEpisode(client, baseLabels, event, finalOutcome) {
    const reason = event.retryReason;
    if (!event.retryTriggered || !reason)
        return;
    const outcome = finalOutcome === 'success' ? 'recovered' : finalOutcome === 'abort' ? 'cancelled' : 'failed';
    swallow(() => client.counter('pi_llm_retry_episode_total', 1, {
        ...baseLabels,
        reason,
        outcome,
    }));
}
/**
 * Per-`PiTurnRunner` metrics host. Owns the running-turn state and hands out
 * one {@link TurnMetricsRecorder} per `runTurn` call.
 */
export class PiTurnMetrics {
    client;
    nowMs;
    /**
     * The host reports with the Desktop metric registry: busy time instead of
     * the active-turn gauge, `route` on the request metrics, the first-output,
     * preparation, response-header and transport metrics, and local resource
     * error kinds. Otherwise (the cloud runtime) the runner reports the Pi
     * metrics it shipped before the registry.
     */
    registryMetrics;
    enabled;
    /**
     * 宿主为 LLM 物理请求失败注入的接收端，用于错误日志上报。它不依赖
     * {@link enabled} 或 `client`：错误日志上报与 metrics 是两条独立链路，
     * 即使不存在 MetricsClient 也保持接入。
     */
    onLLMRequestFailure;
    observeLLMRequest;
    // Running turns of this runner. Runners that share one MetricsClient each
    // add their own busy time, so the counter still sums to the process total.
    // Without registry metrics they feed the per-runner pi_active_turns gauge.
    activeTurns = new Map();
    /** `pi_turn_busy_ms_total`; only a host with registry metrics reports it. */
    busyTime;
    assemblyFingerprints = new Map();
    lastLLMRequestSettledAtBySession = new Map();
    constructor(client, nowMs, enabled = true, onLLMRequestFailure, observeLLMRequest, registryMetrics = false) {
        this.client = client;
        this.nowMs = nowMs;
        this.enabled = enabled;
        this.registryMetrics = registryMetrics;
        this.onLLMRequestFailure = onLLMRequestFailure;
        this.observeLLMRequest = observeLLMRequest;
        // Accrues once per report and at every turn begin and end.
        this.busyTime = registryMetrics
            ? createBusyTimeAccumulator('pi_turn_busy_ms_total', {
                sink: enabled ? client : undefined,
                nowMs,
            })
            : undefined;
    }
    beginTurn(caller, model, diagnostics, turn = {}) {
        return new TurnMetricsRecorder(this, caller ?? 'unknown', model, diagnostics, turn);
    }
    bumpActiveTurns(caller, delta) {
        const next = Math.max(0, (this.activeTurns.get(caller) ?? 0) + delta);
        if (next === 0) {
            this.activeTurns.delete(caller);
        }
        else {
            this.activeTurns.set(caller, next);
        }
        if (this.busyTime)
            this.busyTime.set({ caller }, next);
        else
            this.client.gauge('pi_active_turns', next, { caller });
    }
    observeLLMRequestStarted(sessionId, startedAt) {
        const previous = this.lastLLMRequestSettledAtBySession.get(sessionId);
        if (previous === undefined)
            return undefined;
        return Math.max(0, startedAt - previous);
    }
    observeLLMRequestSettled(sessionId, settledAt) {
        this.lastLLMRequestSettledAtBySession.delete(sessionId);
        this.lastLLMRequestSettledAtBySession.set(sessionId, settledAt);
        if (this.lastLLMRequestSettledAtBySession.size <= MAX_LLM_REQUEST_GAP_BASELINES)
            return;
        const oldest = this.lastLLMRequestSettledAtBySession.keys().next().value;
        if (oldest !== undefined)
            this.lastLLMRequestSettledAtBySession.delete(oldest);
    }
    observeAssembly(caller, model, diagnostics, context) {
        if (!this.enabled)
            return;
        const current = fingerprintAssembly(context);
        const key = JSON.stringify([diagnostics.sessionId, String(model.provider), String(model.id)]);
        const previous = this.assemblyFingerprints.get(key);
        // Refresh insertion order so this map is a bounded process-local LRU.
        this.assemblyFingerprints.delete(key);
        this.assemblyFingerprints.set(key, { ...current, turnId: diagnostics.turnId });
        if (this.assemblyFingerprints.size > MAX_ASSEMBLY_FINGERPRINT_BASELINES) {
            const oldest = this.assemblyFingerprints.keys().next().value;
            if (oldest !== undefined)
                this.assemblyFingerprints.delete(oldest);
        }
        if (!previous)
            return;
        const scope = previous.turnId === diagnostics.turnId ? 'within_turn' : 'across_turn';
        const labels = {
            provider: String(model.provider),
            model: String(model.id),
            caller,
            scope,
        };
        this.observeAssemblyPart(diagnostics, labels, 'system_prompt', previous.systemPrompt, current.systemPrompt);
        this.observeAssemblyPart(diagnostics, labels, 'tools', previous.tools, current.tools);
    }
    observeAssemblyPart(diagnostics, labels, part, previousFingerprint, currentFingerprint) {
        const result = previousFingerprint === currentFingerprint ? 'stable' : 'changed';
        this.client.counter('pi_llm_assembly_stability_total', 1, { ...labels, part, result });
        if (result !== 'changed')
            return;
        swallow(() => diagnostics.logger.info?.({
            session_id: diagnostics.sessionId,
            turn_id: diagnostics.turnId,
            part,
            scope: labels.scope,
            provider: labels.provider,
            model: labels.model,
            caller: labels.caller,
            previous_fingerprint: previousFingerprint,
            current_fingerprint: currentFingerprint,
        }, 'pi_llm_assembly_fingerprint_changed'));
    }
}
/**
 * Per-turn recorder. `PiTurnRunner.runTurn` creates one before any work and
 * always calls {@link finish} in a `finally`, so turn totals and busy time
 * stay balanced on every exit path (completed / failed / aborted / thrown).
 */
export class TurnMetricsRecorder {
    owner;
    caller;
    route;
    /** `{ agentKind }` when the host classified the Turn; empty keeps the legacy label set. */
    agentLabels;
    agentKind;
    wake;
    modelId;
    turnLabels;
    turnStartedAt;
    diagnostics;
    loopSteps = 0;
    batchStartedAt;
    toolStartedAt = new Map();
    toolIOStarted = new Map();
    registeredToolNames = new Set();
    toolOperationClassifiers = new Map();
    finished = false;
    llmFailure;
    terminalFailure;
    // Caller abort can record llm/abort before the Turn settles as cancelled.
    // Retain a real cleanup failure without changing first-wins semantics.
    firstNonLlmTerminalFailure;
    pendingSettlements = [];
    degradationErrors = new WeakSet();
    // The provider result object is also carried by pi's message_end event. Keep the
    // physical request duration beside that identity until EventBridge materialises usage.
    requestDurationsMs = new WeakMap();
    // First-output marks of this turn; they go away with the recorder.
    timing;
    runningAtMs;
    firstRequestStarted = false;
    compactedBeforeFirstRequest = false;
    turnFirstOutputRecorded = false;
    constructor(owner, caller, model, diagnostics, turn = {}) {
        this.owner = owner;
        this.caller = caller;
        this.route = turn.route ?? 'unknown';
        this.timing = turn.timing;
        this.agentKind = turn.agentKind;
        this.agentLabels = agentKindLabels(turn.agentKind);
        this.wake = turn.wake ?? 'system';
        this.modelId = String(model.id);
        this.turnLabels = {
            provider: String(model.provider),
            model: this.modelId,
            caller,
            ...this.agentLabels,
        };
        this.turnStartedAt = owner.nowMs();
        this.diagnostics = diagnostics;
        swallow(() => owner.bumpActiveTurns(caller, +1));
        // The first visible text may come in a later attempt of the turn, after
        // this recorder finished: the binding outlives it with the turn's mark.
        if (this.timing && owner.registryMetrics) {
            turn.visibleText?.bind(() => swallow(() => this.observeFirstVisibleText()));
        }
    }
    /** The turn's running status is written: ends the `persisting` stage. */
    markRunning() {
        this.runningAtMs ??= this.owner.nowMs();
    }
    /**
     * Wrap the fully composed streamFn so one LLM request maps to exactly one
     * `pi_llm_request_total` observation. Request start = wrapper invocation.
     */
    wrapStreamFn(inner, settings = {}) {
        const recordTerminalFailure = settings.recordTerminalFailure ?? true;
        return (async (model, context, streamOptions) => {
            const requestLabels = {
                provider: String(model.provider),
                model: String(model.id),
                caller: this.caller,
                route: this.route,
                ...this.agentLabels,
            };
            const requestStartedAt = this.owner.nowMs();
            const { registryMetrics } = this.owner;
            const phase = readTurnRequestPhase(streamOptions);
            if (registryMetrics)
                swallow(() => this.observeRequestStarted(phase, requestStartedAt));
            const interRequestGapMs = this.owner.observeLLMRequestStarted(this.diagnostics.sessionId, requestStartedAt);
            const settlementObserver = swallowValue(() => this.owner.observeLLMRequest?.({
                sessionId: this.diagnostics.sessionId,
                turnId: this.diagnostics.turnId,
                startedAtMs: requestStartedAt,
                provider: String(model.provider),
                model: String(model.id),
                caller: this.caller,
            }));
            let providerError;
            let hasProviderError = false;
            const callerOnProviderError = streamOptions?.onProviderError;
            const callerOnResponse = streamOptions?.onResponse;
            let responseObserved = false;
            // Providers call onResponse once the response headers arrive, before any
            // event; the Google providers only with the first stream chunk.
            const observeResponse = async (response, observedModel) => {
                if (!responseObserved) {
                    responseObserved = true;
                    swallow(() => this.observeResponseHeaders(phase, requestLabels, requestStartedAt, response));
                }
                await callerOnResponse?.(response, observedModel);
            };
            const observedStreamOptions = {
                ...streamOptions,
                onProviderError(error, observedModel) {
                    providerError = error;
                    hasProviderError = true;
                    swallow(() => callerOnProviderError?.(error, observedModel));
                },
                ...(registryMetrics ? { onResponse: observeResponse } : {}),
            };
            swallow(() => this.owner.observeAssembly(this.caller, model, this.diagnostics, context));
            swallow(() => this.recordToolContextResidency(model, context.messages));
            if (registryMetrics) {
                incrementMetric(this.owner.client, 'pi_llm_request_total', 1, requestLabels);
            }
            else {
                countShippedShape(this.owner.client, 'pi_llm_request_total', this.shippedLabels(requestLabels));
            }
            let stream;
            try {
                stream = await inner(model, context, observedStreamOptions);
            }
            catch (err) {
                // StreamFn contract says failures should be encoded in the stream,
                // but custom streamFns may still throw — count it, then rethrow.
                swallow(() => this.recordLLMSettled(requestLabels, requestStartedAt, model, undefined, err, hasProviderError ? providerError : undefined, recordTerminalFailure, interRequestGapMs, settlementObserver));
                throw err;
            }
            // A custom stream may throw from iteration without ever resolving its
            // result promise. Fold that failure into settlement so observability
            // cannot keep runTurn's finally block pending forever.
            const iteratorFailure = newIteratorFailure();
            const observedResult = Promise.race([
                Promise.resolve().then(() => stream.result()),
                iteratorFailure.promise,
            ]).then((final) => {
                swallow(() => this.recordLLMSettled(requestLabels, requestStartedAt, model, final, undefined, hasProviderError ? providerError : undefined, recordTerminalFailure, interRequestGapMs, settlementObserver));
                return final;
            }, (err) => {
                swallow(() => this.recordLLMSettled(requestLabels, requestStartedAt, model, undefined, err, hasProviderError ? providerError : undefined, recordTerminalFailure, interRequestGapMs, settlementObserver));
                throw err;
            });
            this.pendingSettlements.push(observedResult.catch(() => undefined));
            return observeFirstToken(stream, observedResult, {
                onFirstToken: () => {
                    observeMetric(this.owner.client, 'pi_llm_first_token_ms', this.owner.nowMs() - requestStartedAt, {
                        provider: requestLabels.provider,
                        model: requestLabels.model,
                        caller: this.caller,
                        ...this.agentLabels,
                    });
                },
                ...(registryMetrics
                    ? {
                        onFirstOutput: () => swallow(() => this.observeFirstOutput(phase, requestLabels, requestStartedAt)),
                    }
                    : {}),
            }, iteratorFailure.reject);
        });
    }
    requestDurationMsFor(message) {
        return message !== null && typeof message === 'object'
            ? this.requestDurationsMs.get(message)
            : undefined;
    }
    /** Observe only the final logical call outcome, without recounting provider requests. */
    wrapLogicalStreamFn(inner, settings = {}) {
        const recordFailureByDefault = settings.recordTerminalFailure ?? true;
        return (async (model, context, options) => {
            // A preempted call settles as aborted while its Turn goes on; it is not a failure.
            const recordsFailure = () => recordFailureByDefault && !isLLMCallPreempted(options?.signal);
            // The latest provider error of this logical call, for its system error code only.
            let providerError;
            const callerOnProviderError = options?.onProviderError;
            const observedOptions = {
                ...options,
                onProviderError(error, observedModel) {
                    providerError = error;
                    swallow(() => callerOnProviderError?.(error, observedModel));
                },
            };
            let stream;
            try {
                stream = await inner(model, context, observedOptions);
            }
            catch (error) {
                if (recordsFailure()) {
                    swallow(() => this.recordLogicalLLMFailure(undefined, error));
                }
                throw error;
            }
            const iteratorFailure = newIteratorFailure();
            const observedResult = Promise.race([
                Promise.resolve().then(() => stream.result()),
                iteratorFailure.promise,
            ]).then((final) => {
                if (recordsFailure()) {
                    swallow(() => this.recordLogicalLLMFailure(final, undefined, providerError));
                }
                return final;
            }, (error) => {
                if (recordsFailure()) {
                    swallow(() => this.recordLogicalLLMFailure(undefined, error));
                }
                throw error;
            });
            this.pendingSettlements.push(observedResult.catch(() => undefined));
            return observeFirstToken(stream, observedResult, {}, iteratorFailure.reject);
        });
    }
    /**
     * The first request of a phase other than compaction ends preparation; a
     * compaction request before it marks the turn as compacted.
     */
    observeRequestStarted(phase, startedAtMs) {
        if (this.firstRequestStarted)
            return;
        if (phase === 'compaction') {
            this.compactedBeforeFirstRequest = true;
            return;
        }
        if (phase !== 'initial')
            return;
        this.firstRequestStarted = true;
        if (!this.timing)
            return;
        const stages = turnPrepareStages(this.timing, {
            runningAtMs: this.runningAtMs,
            firstRequestAtMs: startedAtMs,
            compacted: this.compactedBeforeFirstRequest,
        });
        for (const { stage, ms } of stages) {
            observeMetric(this.owner.client, 'pi_turn_prepare_ms', ms, {
                stage,
                caller: this.caller,
                wake: this.wake,
                ...this.agentLabels,
            });
        }
    }
    observeResponseHeaders(phase, labels, startedAtMs, response) {
        if (!measuredPhase(phase))
            return;
        const { client } = this.owner;
        const waitMs = this.owner.nowMs() - startedAtMs;
        const { route, model, caller } = labels;
        observeMetric(client, 'pi_llm_response_header_ms', waitMs, { route, model, caller });
        if (route !== 'managed_token_plan')
            return;
        const timing = parseGatewayServerTiming(responseHeader(response.headers, 'server-timing'));
        const transportMs = managedTransportMs(waitMs, timing);
        if (transportMs !== undefined) {
            observeMetric(client, 'pi_llm_transport_ms', transportMs, { model, caller });
        }
    }
    observeFirstOutput(phase, labels, startedAtMs) {
        if (!measuredPhase(phase))
            return;
        const { client } = this.owner;
        const now = this.owner.nowMs();
        const { route, model, caller } = labels;
        observeMetric(client, 'pi_llm_first_output_ms', now - startedAtMs, {
            route,
            model,
            caller,
            phase,
            ...this.agentLabels,
        });
        if (phase !== 'initial' || this.turnFirstOutputRecorded || !this.timing)
            return;
        this.turnFirstOutputRecorded = true;
        const sinceAcceptedMs = now - this.timing.acceptedAtMs;
        if (!Number.isFinite(sinceAcceptedMs) || sinceAcceptedMs < 0)
            return;
        observeMetric(client, 'pi_turn_first_output_ms', sinceAcceptedMs, {
            route,
            model,
            caller,
            compacted: this.compactedBeforeFirstRequest ? 'true' : 'false',
            wake: this.wake,
            ...this.agentLabels,
        });
    }
    /** The host marked the turn's first visible text; labelled like `pi_turn_first_output_ms`. */
    observeFirstVisibleText() {
        if (!this.timing)
            return;
        const sinceAcceptedMs = this.owner.nowMs() - this.timing.acceptedAtMs;
        if (!Number.isFinite(sinceAcceptedMs) || sinceAcceptedMs < 0)
            return;
        observeMetric(this.owner.client, 'pi_turn_first_visible_text_ms', sinceAcceptedMs, {
            route: this.route,
            model: this.modelId,
            caller: this.caller,
            compacted: this.compactedBeforeFirstRequest ? 'true' : 'false',
            wake: this.wake,
            ...this.agentLabels,
        });
    }
    observeRetry(event) {
        const reason = event.error?.reason;
        if (!reason)
            return;
        const labels = { ...this.turnLabels, reason, scope: event.scope };
        if (event.status === 'waiting' && event.waitingFor === 'network') {
            // An offline device is not a provider failure: keep it out of the retry
            // rate and backoff distribution, which alert on the service.
            swallow(() => this.owner.client.counter('pi_llm_offline_wait_total', 1, {
                ...this.turnLabels,
                scope: event.scope,
            }));
        }
        else if (event.status === 'waiting') {
            swallow(() => this.owner.client.counter('pi_llm_retry_total', 1, labels));
            const { delayMs } = event;
            if (delayMs !== undefined) {
                swallow(() => this.owner.client.histogram('pi_llm_retry_delay_ms', delayMs, labels));
            }
        }
        else if (event.status === 'exhausted') {
            swallow(() => this.owner.client.counter('pi_llm_retry_exhausted_total', 1, labels));
        }
    }
    observeLLMCall(event) {
        if (this.owner.registryMetrics) {
            recordPiLLMCallMetrics(this.owner.client, this.caller, event, this.route, this.agentKind);
        }
        else {
            recordShippedLLMCallMetrics(this.owner.client, this.caller, event, this.agentKind);
        }
    }
    /** Second lightweight subscription — tool/loop/batch observations. */
    observeAgent(agent, runtimeTools) {
        agent.state.tools.forEach((tool) => this.registeredToolNames.add(tool.name));
        for (const tool of runtimeTools ?? []) {
            swallow(() => {
                const classifier = tool.def.operationClassifier;
                if (!classifier || !this.registeredToolNames.has(tool.def.name))
                    return;
                const registered = registerToolOperationClassifier(classifier);
                if (registered.rejectedValueCount > 0) {
                    // Rejected entries silently collapse into the `unknown` bucket at
                    // query time, which looks like a product problem rather than a
                    // vocabulary problem. Name it once at registration instead.
                    this.diagnostics.logger.warn?.({
                        session_id: this.diagnostics.sessionId,
                        turn_id: this.diagnostics.turnId,
                        tool_name: tool.def.name,
                        accepted_operations: registered.allowedValues.size,
                        rejected_operations: registered.rejectedValueCount,
                        max_operations: MAX_TOOL_OPERATION_VALUES,
                        max_operation_length: MAX_TOOL_OPERATION_VALUE_LENGTH,
                    }, 'pi_tool_operation_vocabulary_truncated');
                }
                this.toolOperationClassifiers.set(tool.def.name, registered);
            });
        }
        agent.subscribe((event) => {
            swallow(() => this.onAgentEvent(event));
        });
    }
    getLLMFailureObservation() {
        return this.llmFailure;
    }
    /** A recovered provider error must not become the turn's failure provenance. */
    forgetLLMFailureObservation() {
        this.llmFailure = undefined;
    }
    /**
     * Record the first terminal failure of the turn. `cause` is the error behind
     * it: a local resource it ran out of replaces the kind, never the source.
     */
    tryRecordTerminalFailure(provenance, cause) {
        const localResource = this.owner.registryMetrics
            ? classifyLocalResourceError(cause)
            : undefined;
        const recorded = localResource ? { ...provenance, errorKind: localResource } : provenance;
        if (recorded.errorSource !== 'llm') {
            this.firstNonLlmTerminalFailure ??= recorded;
        }
        if (this.terminalFailure)
            return false;
        this.terminalFailure = recorded;
        return true;
    }
    recordDegradation(errorSource, errorKind, err) {
        if (err && typeof err === 'object') {
            if (this.degradationErrors.has(err))
                return;
            this.degradationErrors.add(err);
        }
        swallow(() => this.owner.client.counter('pi_turn_degradation_total', 1, {
            caller: this.caller,
            errorSource,
            errorKind,
        }));
    }
    async settle() {
        await Promise.all(this.pendingSettlements);
    }
    /** `thrown` is what `runTurn` threw when it ended without a terminal frame. */
    finish(termination, abortReason, thrown) {
        swallow(() => {
            if (this.finished)
                return;
            this.finished = true;
            this.toolIOStarted.clear();
            const { client } = this.owner;
            const caller = this.caller;
            const labels = this.turnLabels;
            this.owner.bumpActiveTurns(caller, -1);
            // pi_turn_total keeps its caller-only labels; the model dimensions live
            // on pi_turn_model_total, which shipped with them. Adding a bounded label
            // in place would also work: gateway-app accepts one metric's series with
            // different label keys (v0.2.51), and sums over the old labels stay the
            // same. `agentKind` rides only on the newer families (turnLabels,
            // pi_turn_failure_total and the pi_tool_call_total / _error_total
            // counters), never on pi_turn_total / pi_turn_error_total.
            client.counter('pi_turn_total', 1, { caller });
            client.counter('pi_turn_model_total', 1, labels);
            const isCancellation = termination?.kind === 'aborted';
            let failure = this.terminalFailure;
            if (isCancellation && failure?.errorSource === 'llm') {
                failure = this.firstNonLlmTerminalFailure;
            }
            if (!failure && termination?.kind === 'failed' && this.llmFailure) {
                failure = { errorSource: 'llm', errorKind: this.failureKind(this.llmFailure) };
            }
            else if (!failure && termination === undefined) {
                const localResource = this.owner.registryMetrics
                    ? classifyLocalResourceError(thrown)
                    : undefined;
                failure = { errorSource: 'runner', errorKind: localResource ?? 'runtime_error' };
            }
            else if (!failure && termination?.kind === 'failed') {
                failure = { errorSource: 'unknown', errorKind: 'unknown' };
            }
            if (failure) {
                // `pi_turn_error_total` shipped as {caller,errorKind}; errorSource
                // belongs to a distinct family so older app versions remain accepted.
                client.counter('pi_turn_error_total', 1, {
                    caller,
                    errorKind: failure.errorKind,
                });
                incrementMetric(client, 'pi_turn_failure_total', 1, {
                    caller,
                    ...this.agentLabels,
                    ...failure,
                });
            }
            if (isCancellation) {
                // Preserve the legacy error family while keeping cancellations out of
                // the failure family. A real terminal failure still takes precedence.
                if (!failure) {
                    client.counter('pi_turn_error_total', 1, { caller, errorKind: 'abort' });
                }
                client.counter('pi_turn_abort_total', 1, {
                    ...labels,
                    abortSource: normalizeAbortSource(abortReason),
                });
            }
            client.histogram('pi_turn_duration_ms', this.owner.nowMs() - this.turnStartedAt, { caller });
            client.histogram('pi_loop_steps', this.loopSteps, { caller });
        });
    }
    onAgentEvent(event) {
        const { client } = this.owner;
        const caller = this.caller;
        switch (event.type) {
            case 'turn_start':
                // One pi turn == one inner loop step (assistant response + tool batch).
                this.loopSteps += 1;
                client.counter('pi_loop_step_total', 1, this.turnLabels);
                this.batchStartedAt = undefined;
                break;
            case 'tool_execution_start': {
                const now = this.owner.nowMs();
                const toolName = this.metricToolName(event.toolName);
                this.toolStartedAt.set(event.toolCallId, now);
                this.batchStartedAt ??= now;
                // Counters carry agentKind so the dashboard can attribute assignment_*
                // calls to Bunny; duration/batch histograms keep their legacy keys.
                client.counter('pi_tool_call_total', 1, { toolName, caller, ...this.agentLabels });
                const operation = this.metricToolOperation(toolName, event.args);
                this.toolIOStarted.set(event.toolCallId, {
                    toolName,
                    ...(operation !== undefined ? { operation } : {}),
                    arguments: measureToolArguments(event.args, this.diagnostics.estimator),
                });
                break;
            }
            case 'tool_execution_end': {
                const now = this.owner.nowMs();
                const toolName = this.metricToolName(event.toolName);
                const startedAt = this.toolStartedAt.get(event.toolCallId);
                this.toolStartedAt.delete(event.toolCallId);
                if (startedAt !== undefined) {
                    client.histogram('pi_tool_call_duration_ms', now - startedAt, {
                        toolName,
                        caller,
                    });
                }
                if (event.isError) {
                    client.counter('pi_tool_call_error_total', 1, {
                        toolName,
                        caller,
                        ...this.agentLabels,
                        errorKind: toolErrorKind(event.result),
                    });
                }
                const toolIO = this.toolIOStarted.get(event.toolCallId);
                this.toolIOStarted.delete(event.toolCallId);
                if (toolIO) {
                    this.recordToolIO(event.toolCallId, toolIO.toolName, toolIO.operation, 'arguments', toolIO.arguments);
                    this.recordToolIO(event.toolCallId, toolIO.toolName, toolIO.operation, 'result', measureToolResult(event.result, this.diagnostics.estimator));
                }
                break;
            }
            case 'turn_end':
                if (this.batchStartedAt !== undefined) {
                    client.histogram('pi_tool_batch_duration_ms', this.owner.nowMs() - this.batchStartedAt, {
                        caller,
                    });
                    this.batchStartedAt = undefined;
                }
                this.toolIOStarted.clear();
                break;
            default:
                break;
        }
    }
    metricToolName(toolName) {
        return this.registeredToolNames.has(toolName) ? toolName : 'unknown';
    }
    metricToolOperation(toolName, args) {
        const classifier = this.toolOperationClassifiers.get(toolName);
        if (!classifier)
            return undefined;
        try {
            const operation = classifier.classify(args);
            return operation !== undefined && classifier.allowedValues.has(operation)
                ? operation
                : 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    recordToolIO(toolCallId, toolName, operation, direction, measured) {
        const labels = { direction, toolName, caller: this.caller };
        const client = this.owner.client;
        client.histogram('pi_tool_io_bytes', measured.bytes, labels);
        const tokens = measured.tokens;
        if (tokens !== undefined) {
            if (tokens >= LARGE_TOOL_IO_TOKEN_THRESHOLD) {
                this.diagnostics.logger.info?.({
                    session_id: this.diagnostics.sessionId,
                    turn_id: this.diagnostics.turnId,
                    tool_call_id: toolCallId,
                    tool_name: toolName,
                    direction,
                    bytes: measured.bytes,
                    estimated_tokens: tokens,
                    caller: this.caller,
                    ...(operation !== undefined ? { tool_operation: operation } : {}),
                }, 'pi_tool_context_large_io_observed');
            }
        }
        if (operation === undefined || direction !== 'result')
            return;
        const operationLabels = { toolName, operation, caller: this.caller };
        swallow(() => client.histogram('pi_tool_operation_result_bytes', measured.bytes, operationLabels));
        if (tokens !== undefined) {
            swallow(() => client.histogram('pi_tool_operation_result_tokens', tokens, operationLabels));
        }
    }
    recordToolContextResidency(model, messages) {
        // 驻留量只记 bytes：不传估算器，避免每次 provider 请求都对整段历史重新估算 token。
        const breakdown = measureToolContext(messages, undefined, (toolName) => this.metricToolName(toolName));
        const labels = {
            provider: String(model.provider),
            model: String(model.id),
            caller: this.caller,
        };
        this.owner.client.histogram('pi_tool_context_resident_bytes', breakdown.argumentBytes, {
            kind: 'arguments',
            ...labels,
        });
        this.owner.client.histogram('pi_tool_context_resident_bytes', breakdown.resultBytes, {
            kind: 'result',
            ...labels,
        });
        for (const [toolName, contribution] of breakdown.byTool) {
            this.recordResidentBytes(toolName, 'arguments', contribution.argumentBytes);
            this.recordResidentBytes(toolName, 'result', contribution.resultBytes);
        }
    }
    recordResidentBytes(toolName, kind, bytes) {
        if (bytes <= 0)
            return;
        this.owner.client.counter('pi_tool_context_resident_bytes_total', bytes, {
            kind,
            toolName,
            caller: this.caller,
        });
    }
    recordLLMSettled(requestLabels, requestStartedAt, model, final, thrown, providerError, recordTerminalFailure = true, interRequestGapMs, settlementObserver) {
        const { client } = this.owner;
        const labels = this.shippedLabels(requestLabels);
        const responseCompletedAt = this.owner.nowMs();
        swallow(() => this.owner.observeLLMRequestSettled(this.diagnostics.sessionId, responseCompletedAt));
        const requestDurationMs = responseCompletedAt - requestStartedAt;
        const cacheOutcome = typeof final?.usage?.cacheRead === 'number'
            ? final.usage.cacheRead > 0
                ? 'read'
                : 'no_read'
            : 'telemetry_unknown';
        if (settlementObserver) {
            swallow(() => settlementObserver({ endedAtMs: responseCompletedAt, cacheOutcome }));
        }
        if (this.owner.registryMetrics) {
            observeMetric(client, 'pi_llm_response_ms', requestDurationMs, requestLabels);
        }
        else {
            observeShippedShape(client, 'pi_llm_response_ms', requestDurationMs, labels);
        }
        if (final && Number.isFinite(requestDurationMs) && requestDurationMs > 0) {
            this.requestDurationsMs.set(final, requestDurationMs);
        }
        const observation = observeLLMFailure(final, thrown, providerError);
        const gapClass = classifyLLMGap(interRequestGapMs);
        swallow(() => client.counter('pi_llm_cache_outcome_total', 1, {
            ...labels,
            gapClass,
            outcome: cacheOutcome,
        }));
        if (final?.usage) {
            emitTokens(client, labels, 'input', final.usage.input);
            emitTokens(client, labels, 'cache', (final.usage.cacheRead ?? 0) + (final.usage.cacheWrite ?? 0));
            emitCacheTokens(client, labels, 'read', final.usage.cacheRead);
            emitCacheTokens(client, labels, 'write', final.usage.cacheWrite);
            emitTokens(client, labels, 'output', final.usage.output);
        }
        if (observation) {
            if (recordTerminalFailure) {
                this.llmFailure ??= observation;
                this.tryRecordTerminalFailure({
                    errorSource: 'llm',
                    errorKind: this.failureKind(observation),
                });
            }
            client.counter('pi_llm_request_error_total', 1, {
                ...labels,
                errorKind: observation.metricKind,
            });
            // 宿主注入的错误日志上报 hook，首期用于 LLM provider 失败。
            // 每次物理请求失败都会触发，包括每个重试 attempt。这里刻意放在物理请求结束点，
            // 而不是逻辑请求包装层，避免把多次重试合并成一条日志。`'abort'` 不是真实的
            // provider 失败，且方案要求“用户取消默认不上报”，因此排除用户取消。
            // 通过 `swallow` 保护调用，保证 hook 抛错也不会破坏请求、重试或 turn。
            if (observation.metricKind !== 'abort' && this.owner.onLLMRequestFailure) {
                const hook = this.owner.onLLMRequestFailure;
                swallow(() => hook({
                    sessionId: this.diagnostics.sessionId,
                    turnId: this.diagnostics.turnId,
                    ...(thrown !== undefined ? { error: thrown } : {}),
                    ...(providerError !== undefined ? { providerError } : {}),
                    ...(final?.errorMessage ? { errorMessage: final.errorMessage } : {}),
                    metricKind: observation.metricKind,
                    request: {
                        api: String(model.api),
                        baseUrl: String(model.baseUrl),
                        caller: this.caller,
                        model: String(model.id),
                        provider: String(model.provider),
                    },
                    occurredAtMs: responseCompletedAt,
                }));
            }
        }
    }
    recordLogicalLLMFailure(final, thrown, providerError) {
        // A request the host refused to send never reached a provider and ends
        // the Turn normally; it is neither an LLM failure nor a Turn failure.
        if (thrown instanceof LLMRequestStoppedError)
            return;
        const observation = observeLLMFailure(final, thrown, providerError);
        if (!observation)
            return;
        this.llmFailure ??= observation;
        this.tryRecordTerminalFailure({ errorSource: 'llm', errorKind: this.failureKind(observation) });
    }
    /** A turn failure's kind: local resource kinds only for hosts with registry metrics. */
    failureKind(observation) {
        return this.owner.registryMetrics ? observation.failureKind : observation.metricKind;
    }
    /** Request labels without `route`, as the metrics next to the request ones report them. */
    shippedLabels(requestLabels) {
        return { ...shippedRequestLabels(requestLabels), ...this.agentLabels };
    }
}
function classifyLLMGap(gapMs) {
    if (gapMs === undefined)
        return 'first_request';
    return gapMs < 300_000 ? 'lt_5m' : 'gte_5m';
}
function observeLLMFailure(final, thrown, providerError) {
    if (thrown === undefined && final?.stopReason !== 'error' && final?.stopReason !== 'aborted') {
        return undefined;
    }
    const normalized = normalizeLLMError({
        ...(thrown !== undefined ? { raw: thrown } : {}),
        ...(providerError !== undefined ? { providerError } : {}),
        finishReason: final?.stopReason,
        errorMessage: final?.errorMessage,
        explicitAbort: final?.stopReason === 'aborted',
    });
    return {
        normalized,
        metricKind: toLLMMetricErrorKind(normalized.facts),
        failureKind: toLLMFailureErrorKind(normalized.facts),
    };
}
function emitTokens(client, labels, kind, count) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0)
        return;
    client.counter('pi_llm_tokens_total', count, { ...labels, kind });
}
function emitCacheTokens(client, labels, operation, count) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0)
        return;
    client.counter('pi_llm_cache_tokens_total', count, { ...labels, operation });
}
function registerToolOperationClassifier(classifier) {
    const allowedValues = new Set();
    let rejectedValueCount = 0;
    for (const value of classifier.allowedValues) {
        if (allowedValues.size >= MAX_TOOL_OPERATION_VALUES ||
            typeof value !== 'string' ||
            value.length === 0 ||
            value.length > MAX_TOOL_OPERATION_VALUE_LENGTH) {
            rejectedValueCount += 1;
            continue;
        }
        allowedValues.add(value);
    }
    return {
        allowedValues,
        rejectedValueCount,
        classify: (args) => classifier.classify(args),
    };
}
/**
 * errorKind for tool failures. Tool errors at this layer are already
 * collapsed into a text result, so keep the bucket set tiny and bounded.
 */
function toolErrorKind(result) {
    const content = result?.content;
    const text = Array.isArray(content)
        ? (content.find((block) => block?.type === 'text')?.text ?? '')
        : '';
    if (/\babort/i.test(text))
        return 'abort';
    if (/\btimed?\s*out\b/i.test(text))
        return 'timeout';
    return 'error';
}
/**
 * Duck-type stream wrapper: forwards iteration/result untouched and fires each
 * observer once, when the turn reads its first matching event. The agent loop
 * only consumes `[Symbol.asyncIterator]()` and `result()`.
 */
function observeFirstToken(stream, result, observers, onIteratorError) {
    let seenToken = false;
    let seenOutput = false;
    const wrapped = {
        [Symbol.asyncIterator]() {
            const inner = createObservedIterator(stream, onIteratorError);
            const iterator = {
                next: async (...args) => {
                    try {
                        const step = await inner.next(...args);
                        const event = step.done ? undefined : step.value;
                        if (event && !seenToken && FIRST_TOKEN_EVENT_TYPES.has(event.type)) {
                            seenToken = true;
                            observers.onFirstToken?.();
                        }
                        if (event && !seenOutput && isEffectiveOutputEvent(event)) {
                            seenOutput = true;
                            observers.onFirstOutput?.();
                        }
                        return step;
                    }
                    catch (error) {
                        onIteratorError(error);
                        throw error;
                    }
                },
            };
            if (inner.return)
                iterator.return = inner.return.bind(inner);
            if (inner.throw)
                iterator.throw = inner.throw.bind(inner);
            return iterator;
        },
        result: () => result,
    };
    return wrapped;
}
function createObservedIterator(stream, onIteratorError) {
    try {
        return stream[Symbol.asyncIterator]();
    }
    catch (error) {
        onIteratorError(error);
        throw error;
    }
}
function newIteratorFailure() {
    let rejectPromise = () => { };
    const promise = new Promise((_, reject) => {
        rejectPromise = reject;
    });
    return { promise, reject: rejectPromise };
}
function agentKindLabels(agentKind) {
    return agentKind ? { agentKind } : {};
}
/** Metrics must never break the product path — not even on client bugs. */
function swallow(fn) {
    try {
        fn();
    }
    catch {
        // intentionally silent
    }
}
function swallowValue(fn) {
    try {
        return fn();
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=metrics.js.map