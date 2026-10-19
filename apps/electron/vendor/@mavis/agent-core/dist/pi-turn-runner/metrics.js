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
import { normalizeLLMError, toLLMMetricErrorKind, } from '@mavis/shared/llm-error-classifier';
import { normalizeAbortSource, } from './types.js';
import { createToolContextHistogramBucketsByName, measureToolArguments, measureToolContext, measureToolResult, } from './tool-context-size.js';
import { fingerprintAssembly } from './assembly-fingerprint.js';
const LARGE_TOOL_IO_TOKEN_THRESHOLD = 8_000;
const MAX_ASSEMBLY_FINGERPRINT_BASELINES = 2_048;
const MAX_LLM_REQUEST_GAP_BASELINES = 2_048;
const LLM_TOKENS_PER_SECOND_BUCKETS = [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
const LLM_GAP_MS_BUCKETS = [
    100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
    1_800_000, 3_600_000,
];
const MAX_TOOL_OPERATION_VALUES = 128;
const MAX_TOOL_OPERATION_VALUE_LENGTH = 64;
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
export function newPiTurnMetrics(client, nowMs, onLLMRequestFailure, observeLLMRequest) {
    return new PiTurnMetrics(client ?? noopMetricsClient, nowMs, client !== undefined, onLLMRequestFailure, observeLLMRequest);
}
export function createPiTurnHistogramBucketsByName() {
    return {
        pi_llm_tokens_per_second: [...LLM_TOKENS_PER_SECOND_BUCKETS],
        pi_llm_inter_request_gap_ms: [...LLM_GAP_MS_BUCKETS],
        ...createToolContextHistogramBucketsByName(),
    };
}
/**
 * Record the final outcome of one logical LLM call without conflating it with
 * its physical retry attempts. All labels are fixed-cardinality framework
 * classifications.
 */
export function recordPiLLMCallMetrics(client, caller, event) {
    if (!client)
        return;
    const baseLabels = {
        provider: event.provider,
        model: event.model,
        caller,
        scope: event.scope,
    };
    swallow(() => client.counter('pi_llm_logical_call_total', 1, {
        ...baseLabels,
        outcome: event.final.outcome,
        errorKind: event.final.errorKind,
        retryTriggered: String(event.retryTriggered),
    }));
    const reason = event.retryReason;
    if (!event.retryTriggered || !reason)
        return;
    const outcome = event.final.outcome === 'success'
        ? 'recovered'
        : event.final.outcome === 'abort'
            ? 'cancelled'
            : 'failed';
    swallow(() => client.counter('pi_llm_retry_episode_total', 1, {
        ...baseLabels,
        reason,
        outcome,
    }));
}
/**
 * Per-`PiTurnRunner` metrics host. Owns the concurrent-turn gauge state and
 * hands out one {@link TurnMetricsRecorder} per `runTurn` call.
 */
export class PiTurnMetrics {
    client;
    nowMs;
    enabled;
    /**
     * 宿主为 LLM 物理请求失败注入的接收端，用于错误日志上报。它不依赖
     * {@link enabled} 或 `client`：错误日志上报与 metrics 是两条独立链路，
     * 即使不存在 MetricsClient 也保持接入。
     */
    onLLMRequestFailure;
    observeLLMRequest;
    // ponytail: gauge scope is per-runner instance — the local product path
    // constructs a single PiTurnRunner per process, which is what the gauge is
    // meant to describe. Move to a shared registry if multiple runners ever
    // share one MetricsClient.
    activeTurns = new Map();
    assemblyFingerprints = new Map();
    lastLLMRequestSettledAtBySession = new Map();
    constructor(client, nowMs, enabled = true, onLLMRequestFailure, observeLLMRequest) {
        this.client = client;
        this.nowMs = nowMs;
        this.enabled = enabled;
        this.onLLMRequestFailure = onLLMRequestFailure;
        this.observeLLMRequest = observeLLMRequest;
    }
    beginTurn(caller, model, diagnostics) {
        return new TurnMetricsRecorder(this, caller ?? 'unknown', model, diagnostics);
    }
    bumpActiveTurns(caller, delta) {
        const next = Math.max(0, (this.activeTurns.get(caller) ?? 0) + delta);
        if (next === 0) {
            this.activeTurns.delete(caller);
        }
        else {
            this.activeTurns.set(caller, next);
        }
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
 * always calls {@link finish} in a `finally`, so turn totals/gauges stay
 * balanced on every exit path (completed / failed / aborted / thrown).
 */
export class TurnMetricsRecorder {
    owner;
    caller;
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
    constructor(owner, caller, model, diagnostics) {
        this.owner = owner;
        this.caller = caller;
        this.turnLabels = {
            provider: String(model.provider),
            model: String(model.id),
            caller,
        };
        this.turnStartedAt = owner.nowMs();
        this.diagnostics = diagnostics;
        swallow(() => owner.bumpActiveTurns(caller, +1));
    }
    /**
     * Wrap the fully composed streamFn so one LLM request maps to exactly one
     * `pi_llm_request_total` observation. Request start = wrapper invocation.
     */
    wrapStreamFn(inner, settings = {}) {
        const recordTerminalFailure = settings.recordTerminalFailure ?? true;
        return (async (model, context, streamOptions) => {
            const labels = {
                provider: String(model.provider),
                model: String(model.id),
                caller: this.caller,
            };
            const requestStartedAt = this.owner.nowMs();
            const interRequestGapMs = this.owner.observeLLMRequestStarted(this.diagnostics.sessionId, requestStartedAt);
            const settlementObserver = swallowValue(() => this.owner.observeLLMRequest?.({
                sessionId: this.diagnostics.sessionId,
                turnId: this.diagnostics.turnId,
                startedAtMs: requestStartedAt,
                provider: String(model.provider),
                model: String(model.id),
                caller: this.caller,
            }));
            if (interRequestGapMs !== undefined) {
                swallow(() => this.owner.client.histogram('pi_llm_inter_request_gap_ms', interRequestGapMs, labels));
            }
            let providerError;
            let hasProviderError = false;
            const callerOnProviderError = streamOptions?.onProviderError;
            const observedStreamOptions = {
                ...streamOptions,
                onProviderError(error, observedModel) {
                    providerError = error;
                    hasProviderError = true;
                    swallow(() => callerOnProviderError?.(error, observedModel));
                },
            };
            swallow(() => this.owner.observeAssembly(this.caller, model, this.diagnostics, context));
            swallow(() => this.recordToolContextResidency(model, context.messages));
            swallow(() => this.owner.client.counter('pi_llm_request_total', 1, labels));
            let stream;
            try {
                stream = await inner(model, context, observedStreamOptions);
            }
            catch (err) {
                // StreamFn contract says failures should be encoded in the stream,
                // but custom streamFns may still throw — count it, then rethrow.
                swallow(() => this.recordLLMSettled(labels, requestStartedAt, model, undefined, err, hasProviderError ? providerError : undefined, recordTerminalFailure, interRequestGapMs, settlementObserver));
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
                swallow(() => this.recordLLMSettled(labels, requestStartedAt, model, final, undefined, hasProviderError ? providerError : undefined, recordTerminalFailure, interRequestGapMs, settlementObserver));
                return final;
            }, (err) => {
                swallow(() => this.recordLLMSettled(labels, requestStartedAt, model, undefined, err, hasProviderError ? providerError : undefined, recordTerminalFailure, interRequestGapMs, settlementObserver));
                throw err;
            });
            this.pendingSettlements.push(observedResult.catch(() => undefined));
            return observeFirstToken(stream, observedResult, () => {
                const observedAt = this.owner.nowMs();
                swallow(() => this.owner.client.histogram('pi_llm_first_token_ms', observedAt - requestStartedAt, labels));
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
        const recordTerminalFailure = settings.recordTerminalFailure ?? true;
        return (async (model, context, options) => {
            let stream;
            try {
                stream = await inner(model, context, options);
            }
            catch (error) {
                if (recordTerminalFailure) {
                    swallow(() => this.recordLogicalLLMFailure(undefined, error));
                }
                throw error;
            }
            const iteratorFailure = newIteratorFailure();
            const observedResult = Promise.race([
                Promise.resolve().then(() => stream.result()),
                iteratorFailure.promise,
            ]).then((final) => {
                if (recordTerminalFailure) {
                    swallow(() => this.recordLogicalLLMFailure(final));
                }
                return final;
            }, (error) => {
                if (recordTerminalFailure) {
                    swallow(() => this.recordLogicalLLMFailure(undefined, error));
                }
                throw error;
            });
            this.pendingSettlements.push(observedResult.catch(() => undefined));
            return observeFirstToken(stream, observedResult, () => { }, iteratorFailure.reject);
        });
    }
    observeRetry(event) {
        const reason = event.error?.reason;
        if (!reason)
            return;
        const labels = { ...this.turnLabels, reason, scope: event.scope };
        if (event.status === 'waiting') {
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
        recordPiLLMCallMetrics(this.owner.client, this.caller, event);
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
    tryRecordTerminalFailure(provenance) {
        if (provenance.errorSource !== 'llm') {
            this.firstNonLlmTerminalFailure ??= provenance;
        }
        if (this.terminalFailure)
            return false;
        this.terminalFailure = provenance;
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
    finish(termination, abortReason) {
        swallow(() => {
            if (this.finished)
                return;
            this.finished = true;
            this.toolIOStarted.clear();
            const { client } = this.owner;
            const caller = this.caller;
            const labels = this.turnLabels;
            this.owner.bumpActiveTurns(caller, -1);
            // Prometheus freezes a metric family's label keys. Keep the legacy
            // family schema stable and put model dimensions under a new name.
            client.counter('pi_turn_total', 1, { caller });
            client.counter('pi_turn_model_total', 1, labels);
            const isCancellation = termination?.kind === 'aborted';
            let failure = this.terminalFailure;
            if (isCancellation && failure?.errorSource === 'llm') {
                failure = this.firstNonLlmTerminalFailure;
            }
            if (!failure && termination?.kind === 'failed' && this.llmFailure) {
                failure = { errorSource: 'llm', errorKind: this.llmFailure.metricKind };
            }
            else if (!failure && termination === undefined) {
                failure = { errorSource: 'runner', errorKind: 'runtime_error' };
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
                client.counter('pi_turn_failure_total', 1, { caller, ...failure });
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
                client.counter('pi_tool_call_total', 1, { toolName, caller });
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
            client.histogram('pi_tool_io_tokens', tokens, labels);
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
        const breakdown = measureToolContext(messages, this.diagnostics.estimator, (toolName) => this.metricToolName(toolName));
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
        if (breakdown.argumentTokens !== undefined) {
            this.owner.client.histogram('pi_tool_context_resident_tokens', breakdown.argumentTokens, {
                kind: 'arguments',
                ...labels,
            });
        }
        if (breakdown.resultTokens !== undefined) {
            this.owner.client.histogram('pi_tool_context_resident_tokens', breakdown.resultTokens, {
                kind: 'result',
                ...labels,
            });
        }
        for (const [toolName, contribution] of breakdown.byTool) {
            this.recordResidentContribution(toolName, 'arguments', {
                bytes: contribution.argumentBytes,
                ...(contribution.argumentTokens !== undefined
                    ? { tokens: contribution.argumentTokens }
                    : {}),
            });
            this.recordResidentContribution(toolName, 'result', {
                bytes: contribution.resultBytes,
                ...(contribution.resultTokens !== undefined ? { tokens: contribution.resultTokens } : {}),
            });
        }
    }
    recordResidentContribution(toolName, kind, measured) {
        const labels = { kind, toolName, caller: this.caller };
        if (measured.bytes > 0) {
            this.owner.client.counter('pi_tool_context_resident_bytes_total', measured.bytes, labels);
        }
        if (measured.tokens !== undefined && measured.tokens > 0) {
            this.owner.client.counter('pi_tool_context_resident_tokens_total', measured.tokens, labels);
        }
    }
    recordLLMSettled(labels, requestStartedAt, model, final, thrown, providerError, recordTerminalFailure = true, interRequestGapMs, settlementObserver) {
        const { client } = this.owner;
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
        client.histogram('pi_llm_response_ms', requestDurationMs, labels);
        if (final && Number.isFinite(requestDurationMs) && requestDurationMs > 0) {
            this.requestDurationsMs.set(final, requestDurationMs);
        }
        const observation = observeLLMFailure(final, thrown);
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
            if (!observation) {
                emitOutputTokensPerSecond(client, labels, final.usage.output, requestStartedAt, responseCompletedAt);
            }
        }
        if (observation) {
            if (recordTerminalFailure) {
                this.llmFailure ??= observation;
                this.tryRecordTerminalFailure({ errorSource: 'llm', errorKind: observation.metricKind });
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
    recordLogicalLLMFailure(final, thrown) {
        const observation = observeLLMFailure(final, thrown);
        if (!observation)
            return;
        this.llmFailure ??= observation;
        this.tryRecordTerminalFailure({ errorSource: 'llm', errorKind: observation.metricKind });
    }
}
function classifyLLMGap(gapMs) {
    if (gapMs === undefined)
        return 'first_request';
    return gapMs < 300_000 ? 'lt_5m' : 'gte_5m';
}
function observeLLMFailure(final, thrown) {
    if (thrown === undefined && final?.stopReason !== 'error' && final?.stopReason !== 'aborted') {
        return undefined;
    }
    const normalized = normalizeLLMError({
        ...(thrown !== undefined ? { raw: thrown } : {}),
        finishReason: final?.stopReason,
        errorMessage: final?.errorMessage,
        explicitAbort: final?.stopReason === 'aborted',
    });
    return { normalized, metricKind: toLLMMetricErrorKind(normalized.facts) };
}
function emitTokens(client, labels, kind, count) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0)
        return;
    client.counter('pi_llm_tokens_total', count, { ...labels, kind });
}
function emitOutputTokensPerSecond(client, labels, outputTokens, requestStartedAt, responseCompletedAt) {
    if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) {
        return;
    }
    const requestDurationMs = responseCompletedAt - requestStartedAt;
    if (!Number.isFinite(requestDurationMs) || requestDurationMs <= 0)
        return;
    const tokensPerSecond = outputTokens / (requestDurationMs / 1_000);
    if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0)
        return;
    client.histogram('pi_llm_tokens_per_second', tokensPerSecond, labels);
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
 * Duck-type stream wrapper: forwards iteration/result untouched and fires
 * `onFirstToken` once on the first content-bearing event. The agent loop only
 * consumes `[Symbol.asyncIterator]()` and `result()`.
 */
function observeFirstToken(stream, result, onFirstToken, onIteratorError) {
    let seen = false;
    const wrapped = {
        [Symbol.asyncIterator]() {
            const inner = createObservedIterator(stream, onIteratorError);
            const iterator = {
                next: async (...args) => {
                    try {
                        const step = await inner.next(...args);
                        if (!seen && !step.done && step.value && FIRST_TOKEN_EVENT_TYPES.has(step.value.type)) {
                            seen = true;
                            onFirstToken();
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