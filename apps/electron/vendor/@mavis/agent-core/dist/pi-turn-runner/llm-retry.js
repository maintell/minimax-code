import { isContextOverflow, } from '@earendil-works/pi-ai';
import { isLLMDeterministicRequestRejection, normalizeLLMError, toLLMMetricErrorKind, toLLMProtocolClassification, toLLMRetryDecision, } from '@mavis/shared/llm-error-classifier';
function isByokProvider(provider) {
    return provider === 'minimax_api' || provider.startsWith('custom_provider:');
}
/** Symbol-keyed identity shared by physical attempts of one logical call. */
export const LLM_RETRY_CALL_IDENTITY = Symbol('mavis.llmRetryCallIdentity');
/** Symbol-keyed observer for every physical provider request in a logical call. */
export const LLM_RETRY_REQUEST_SETTLED_OBSERVER = Symbol('mavis.llmRetryRequestSettledObserver');
export const DEFAULT_LLM_RETRY_POLICY = {
    // Local patch: provider errors retry without a practical limit on a fixed
    // three-second cadence (no backoff, no wall-clock budget). The budget is the
    // largest serialisable integer because the retry-event contract requires a
    // non-negative integer; only user cancellation, model refusals, wrong
    // credentials, exhausted quota and deterministic request rejections stay
    // terminal.
    maxRetries: 2_147_483_647,
    baseDelayMs: 3_000,
    maxDelayMs: 30_000,
    maxRetryElapsedMs: Number.POSITIVE_INFINITY,
};
/** Message prefix of {@link LLMRequestStoppedError}; Pi keeps only the message of a run failure. */
export const LLM_REQUEST_STOPPED_MESSAGE_PREFIX = 'LLM request stopped before sending:';
/** The host refused to send a logical request (see `LLMRequestAdmission`). */
export class LLMRequestStoppedError extends Error {
    reason;
    name = 'LLMRequestStoppedError';
    constructor(reason) {
        super(`${LLM_REQUEST_STOPPED_MESSAGE_PREFIX} ${reason}`);
        this.reason = reason;
    }
}
/** Whether a Pi run failure is a request the host refused to send. */
export function isLLMRequestStoppedMessage(message) {
    return message?.startsWith(LLM_REQUEST_STOPPED_MESSAGE_PREFIX) === true;
}
const PUBLIC_ERROR_MESSAGES = {
    abort: 'LLM request was cancelled',
    timeout: 'LLM request timed out',
    rate_limited: 'LLM provider rate limited the request',
    tpm_rate_limited: 'LLM provider token rate limit reached',
    usage_limit: 'LLM usage limit reached',
    credits_exhausted: 'LLM credits exhausted',
    auth: 'LLM provider authentication failed',
    bad_request: 'LLM provider rejected the request',
    not_found: 'LLM provider resource not found',
    content_filter: 'LLM provider blocked the response',
    server_error: 'LLM provider request failed',
    overloaded: 'LLM provider is overloaded',
    network: 'LLM network connection failed',
    empty_response: 'LLM provider returned an empty response',
    unknown: 'LLM request failed',
    length: 'LLM response reached the length limit',
};
/** Add framework-owned transport retry to a provider StreamFn. Hosts opt in explicitly. */
export function withLLMRetry(inner, input) {
    const policy = resolvePolicy(input.policy);
    const nowMs = input.nowMs ?? Date.now;
    const random = input.random ?? Math.random;
    const sleep = input.sleep ?? abortableSleep;
    const lifecycle = input.scope === 'agent' && input.requestLifecycle
        ? input.requestLifecycle
        : input.scope !== 'title' && input.usageRecorder
            ? recordingLifecycle(input.usageRecorder, input.scope)
            : undefined;
    return (async (model, originalContext, options) => {
        const callId = input.generateCallId?.() ?? defaultCallId();
        const callIdentity = {};
        const callState = { retryTriggered: false, requestAttempts: 0 };
        const request = await admitRequest(lifecycle, callId, originalContext);
        const { context } = request;
        let retryStartedAtMs;
        let requestAttempt = 1;
        let lastFailure;
        while (requestAttempt <= policy.maxRetries + 1) {
            if (options?.signal?.aborted) {
                const error = abortError(options.signal);
                notifyCallSettled({ input, model, callId, state: callState, signal: options.signal }, error);
                await request.settleThrown(error, options.signal);
                throw error;
            }
            try {
                await lifecycle?.beforeAttempt({ callId, requestAttempt });
            }
            catch (error) {
                // Nothing of this attempt reached the transport: settle with the
                // attempts already known so the reservation is released or charged
                // exactly, instead of staying open until a restart recovers it.
                notifyCallSettled({ input, model, callId, state: callState, signal: options?.signal }, error);
                await request.settleThrown(error, options?.signal);
                throw error;
            }
            const preflight = await preflightAttempt(inner, model, context, options, nowMs, callIdentity, isByokProvider(model.provider), requestAttempt, request.observeAttempt(requestSettledObserver(options)));
            callState.requestAttempts = requestAttempt;
            if (preflight.kind === 'committed') {
                if (requestAttempt > 1) {
                    await notify(input.observer, {
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        callId,
                        scope: input.scope,
                        status: 'recovered',
                        retryAttempt: requestAttempt - 1,
                        maxRetries: policy.maxRetries,
                        requestAttempt,
                    });
                }
                return request.settleWith(observeCallSettlement(preflight.stream, {
                    input,
                    model,
                    callId,
                    state: callState,
                    signal: options?.signal,
                }), options?.signal);
            }
            if (preflight.kind === 'terminal') {
                if (requestAttempt > 1 && lastFailure) {
                    const cancelled = options?.signal?.aborted || isAbortFailure(preflight.failure);
                    await notify(input.observer, {
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        callId,
                        scope: input.scope,
                        status: cancelled ? 'cancelled' : 'exhausted',
                        retryAttempt: requestAttempt - 1,
                        maxRetries: policy.maxRetries,
                        requestAttempt,
                        // The terminal attempt may differ from the transient failure that
                        // caused the retry (for example 529 followed by quota exhaustion).
                        // Expose the actual final error so downstream code/message handling
                        // never reports the stale previous attempt.
                        error: preflight.failure.error,
                    });
                }
                return request.settleWith(await request.guardThrow(options?.signal, () => observeTerminalFailure(preflight.failure, {
                    input,
                    model,
                    callId,
                    state: callState,
                    signal: options?.signal,
                })), options?.signal);
            }
            lastFailure = preflight.failure;
            const retryAttempt = requestAttempt;
            const delayMs = retryDelayMs(lastFailure.retryAfterMs, retryAttempt, policy, random);
            const failureAtMs = nowMs();
            retryStartedAtMs ??= failureAtMs;
            const retryDeadlineExceeded = failureAtMs + delayMs - retryStartedAtMs > policy.maxRetryElapsedMs;
            if (requestAttempt > policy.maxRetries || retryDeadlineExceeded) {
                await notify(input.observer, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    callId,
                    scope: input.scope,
                    status: 'exhausted',
                    retryAttempt: requestAttempt - 1,
                    maxRetries: policy.maxRetries,
                    requestAttempt,
                    error: lastFailure.error,
                });
                const exhausted = lastFailure;
                return request.settleWith(await request.guardThrow(options?.signal, () => observeTerminalFailure(exhausted, {
                    input,
                    model,
                    callId,
                    state: callState,
                    signal: options?.signal,
                })), options?.signal);
            }
            callState.retryTriggered = true;
            callState.retryReason ??= lastFailure.retryReason;
            discardAttempt(lastFailure);
            await notify(input.observer, {
                sessionId: input.sessionId,
                turnId: input.turnId,
                callId,
                scope: input.scope,
                status: 'waiting',
                retryAttempt,
                maxRetries: policy.maxRetries,
                requestAttempt: requestAttempt + 1,
                delayMs,
                nextRetryAtMs: failureAtMs + delayMs,
                error: lastFailure.error,
            });
            try {
                await sleep(delayMs, options?.signal);
            }
            catch (error) {
                await notify(input.observer, {
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    callId,
                    scope: input.scope,
                    status: 'cancelled',
                    retryAttempt,
                    maxRetries: policy.maxRetries,
                    requestAttempt: requestAttempt + 1,
                    error: lastFailure.error,
                });
                notifyCallSettled({ input, model, callId, state: callState, signal: options?.signal }, error);
                await request.settleThrown(error, options?.signal);
                throw error;
            }
            requestAttempt += 1;
        }
        if (lastFailure) {
            const exhausted = lastFailure;
            return request.settleWith(await request.guardThrow(options?.signal, () => observeTerminalFailure(exhausted, {
                input,
                model,
                callId,
                state: callState,
                signal: options?.signal,
            })), options?.signal);
        }
        const error = new Error('LLM retry loop ended without a provider result');
        notifyCallSettled({ input, model, callId, state: callState, signal: options?.signal }, error);
        await request.settleThrown(error, options?.signal);
        throw error;
    });
}
/** A lifecycle that admits every request unchanged and only records its attempts. */
function recordingLifecycle(recorder, scope) {
    return {
        admit: async () => ({ kind: 'send', tools: 'all' }),
        beforeAttempt: async () => undefined,
        ...(recorder.recordAttempts
            ? {
                recordAttempts: async ({ callId, attempts }) => {
                    await recorder.recordAttempts?.({ callId, scope, attempts });
                },
            }
            : {}),
        settle: async (settlement) => {
            try {
                await recorder.settle({ ...settlement, scope });
            }
            catch {
                // Counting only: a recorder failure never fails the request.
            }
        },
    };
}
/**
 * Admit one logical request through the host lifecycle. Without a lifecycle
 * every method is a pass-through, so hosts that do not account requests keep
 * the exact pre-lifecycle stream composition.
 */
async function admitRequest(lifecycle, callId, context) {
    if (!lifecycle) {
        return {
            context,
            observeAttempt: (observer) => observer,
            settleWith: (stream) => stream,
            settleThrown: async () => undefined,
            guardThrow: async (_signal, step) => step(),
        };
    }
    const admission = await lifecycle.admit({ callId });
    if (admission.kind === 'stop') {
        // Nothing was handed to the transport: settle so the reservation is
        // released. No call settles either, so call metrics see no LLM failure.
        const error = new LLMRequestStoppedError(admission.reason);
        await lifecycle.settle({ callId, outcome: 'abort', attempts: [] });
        throw error;
    }
    const attempts = [];
    const recordAttempts = lifecycle.recordAttempts?.bind(lifecycle);
    // The chain of attempt records issued so far; settlement waits for it.
    let recorded;
    let settled;
    const settle = (final, thrown, aborted) => {
        if (!settled) {
            const settlement = {
                callId,
                outcome: classifyCallOutcome(final, thrown, aborted).outcome,
                attempts: [...attempts],
            };
            settled = recorded
                ? recorded.then(() => lifecycle.settle(settlement))
                : lifecycle.settle(settlement);
        }
        return settled;
    };
    return {
        context: projectAdmittedContext(context, admission),
        observeAttempt: (observer) => (event) => {
            attempts.push(event);
            if (recordAttempts) {
                const input = { callId, attempts: [...attempts] };
                recorded = (recorded ?? Promise.resolve())
                    .then(() => recordAttempts(input))
                    .catch(() => {
                    // A record is a durability checkpoint, not a barrier: `settle`
                    // still carries every attempt, so the request goes on.
                });
            }
            observer?.(event);
        },
        settleWith: (stream, signal) => gateResult(stream, settle, signal, admission.tools === 'none' ? withoutToolIntents : undefined),
        settleThrown: (error, signal) => settle(undefined, error, signal?.aborted === true),
        guardThrow: async (signal, step) => {
            try {
                return step();
            }
            catch (error) {
                await settle(undefined, error, signal?.aborted === true);
                throw error;
            }
        },
    };
}
function projectAdmittedContext(context, admission) {
    if (admission.tools === 'all' && !admission.instruction)
        return context;
    return {
        ...context,
        ...(admission.tools === 'none' ? { tools: [] } : {}),
        ...(admission.instruction
            ? {
                systemPrompt: context.systemPrompt
                    ? `${context.systemPrompt}\n\n${admission.instruction}`
                    : admission.instruction,
            }
            : {}),
    };
}
/**
 * A request sent without tools may still come back with tool intents. They
 * are dropped before the agent loop sees the message, so nothing runs and no
 * proposal is made; the request is still settled with the provider's answer.
 */
function withoutToolIntents(final) {
    if (!final.content.some((block) => block.type === 'toolCall'))
        return final;
    return {
        ...final,
        content: final.content.filter((block) => block.type !== 'toolCall'),
        stopReason: final.stopReason === 'toolUse' ? 'stop' : final.stopReason,
    };
}
function withoutToolIntentEvent(event) {
    if (event.type === 'toolcall_start' ||
        event.type === 'toolcall_delta' ||
        event.type === 'toolcall_end') {
        return undefined;
    }
    if (event.type !== 'done')
        return event;
    return {
        ...event,
        reason: event.reason === 'toolUse' ? 'stop' : event.reason,
        message: withoutToolIntents(event.message),
    };
}
/**
 * Hold the logical result until the host settled the request. Pi awaits
 * `result()` before it emits `message_end`, runs tools or sends the next
 * request, so every later step observes the settled ledger.
 */
function gateResult(source, settle, signal, project) {
    let gated;
    const result = () => {
        gated ??= Promise.resolve()
            .then(() => source.result())
            .then(async (final) => {
            await settle(final, undefined, signal?.aborted === true);
            return project ? project(final) : final;
        }, async (error) => {
            await settle(undefined, error, signal?.aborted === true);
            throw error;
        });
        return gated;
    };
    return {
        [Symbol.asyncIterator]() {
            const inner = source[Symbol.asyncIterator]();
            // A consumer that only iterates still waits for the settlement at the end.
            const iterator = {
                async next(...args) {
                    for (;;) {
                        let next;
                        try {
                            next = await inner.next(...args);
                        }
                        catch (error) {
                            await result().catch(() => undefined);
                            throw error;
                        }
                        if (next.done) {
                            await result().catch(() => undefined);
                            return next;
                        }
                        if (!project)
                            return next;
                        const event = withoutToolIntentEvent(next.value);
                        if (event)
                            return { done: false, value: event };
                    }
                },
            };
            if (inner.return)
                iterator.return = inner.return.bind(inner);
            if (inner.throw)
                iterator.throw = inner.throw.bind(inner);
            return iterator;
        },
        result,
    };
}
async function preflightAttempt(inner, model, context, options, nowMs, callIdentity, retryAllErrors, requestAttempt, onRequestSettled) {
    let response;
    const callerOnResponse = options?.onResponse;
    const attemptOptions = {
        ...(options ?? {}),
        maxRetries: 0,
        onResponse: async (value, responseModel) => {
            response = value;
            await callerOnResponse?.(value, responseModel);
        },
    };
    Object.defineProperty(attemptOptions, LLM_RETRY_CALL_IDENTITY, {
        value: callIdentity,
        // StreamFn composition uses object spread. Enumerable symbol keys survive
        // those wrappers while remaining invisible to JSON/provider payloads.
        enumerable: true,
    });
    let stream;
    try {
        stream = await inner(model, context, attemptOptions);
    }
    catch (thrown) {
        notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
        return failureResult({ thrown, response, buffered: [], nowMs, retryAllErrors });
    }
    let iterator;
    try {
        iterator = stream[Symbol.asyncIterator]();
    }
    catch (thrown) {
        notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
        return failureResult({ thrown, response, stream, buffered: [], nowMs, retryAllErrors });
    }
    const buffered = [];
    for (;;) {
        let next;
        try {
            next = await iterator.next();
        }
        catch (thrown) {
            notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
            return failureResult({ thrown, response, stream, iterator, buffered, nowMs, retryAllErrors });
        }
        if (next.done) {
            try {
                const final = await stream.result();
                if (isFailureMessage(final)) {
                    notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
                    return failureResult({
                        final,
                        response,
                        stream,
                        iterator,
                        buffered,
                        nowMs,
                        retryAllErrors,
                    });
                }
                notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
                return { kind: 'committed', stream: replayStream(stream, iterator, buffered) };
            }
            catch (thrown) {
                notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
                return failureResult({
                    thrown,
                    response,
                    stream,
                    iterator,
                    buffered,
                    nowMs,
                    retryAllErrors,
                });
            }
        }
        buffered.push(next.value);
        if (next.value.type === 'error') {
            notifyRequestSettled(onRequestSettled, requestAttempt, next.value.error, undefined, options?.signal);
            return failureResult({
                final: next.value.error,
                response,
                stream,
                iterator,
                buffered,
                nowMs,
                retryAllErrors,
            });
        }
        // A visible delta is the retry commit boundary for every provider. Once
        // callers can observe output, silently replacing the physical request
        // would either buffer the whole response or replay duplicate content.
        // BYOK keeps its broader pre-output retry classification, but a later
        // stream failure must stay on the already-committed attempt.
        if (commitsOutput(next.value)) {
            return {
                kind: 'committed',
                stream: observeRequestSettlement(replayStream(stream, iterator, buffered), requestAttempt, onRequestSettled, options?.signal),
            };
        }
    }
}
function requestSettledObserver(options) {
    return options?.[LLM_RETRY_REQUEST_SETTLED_OBSERVER];
}
function notifyRequestSettled(observer, requestAttempt, final, thrown, signal) {
    if (!observer)
        return;
    const providerUsage = readProviderUsage(final);
    try {
        observer({
            requestAttempt,
            outcome: classifyCallOutcome(final, thrown, signal?.aborted === true).outcome,
            ...(providerUsage.usage ? { usage: providerUsage.usage } : {}),
            usageComplete: providerUsage.complete,
            ...(final && typeof final.api === 'string' && typeof final.provider === 'string'
                ? { route: { api: final.api, provider: final.provider } }
                : {}),
        });
    }
    catch {
        // Physical-call observability must never change provider-call behavior.
    }
}
function observeRequestSettlement(source, requestAttempt, observer, signal) {
    if (!observer)
        return source;
    let settled = false;
    const settle = (final, error) => {
        if (settled)
            return;
        settled = true;
        notifyRequestSettled(observer, requestAttempt, final, error, signal);
    };
    const result = Promise.resolve()
        .then(() => source.result())
        .then((final) => {
        settle(final);
        return final;
    }, (error) => {
        settle(undefined, error);
        throw error;
    });
    void result.catch(() => undefined);
    return {
        [Symbol.asyncIterator]() {
            let inner;
            try {
                inner = source[Symbol.asyncIterator]();
            }
            catch (error) {
                settle(undefined, error);
                throw error;
            }
            const iterator = {
                async next(...args) {
                    try {
                        return await inner.next(...args);
                    }
                    catch (error) {
                        settle(undefined, error);
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
}
function failureResult(input) {
    // A 2xx response status only says the stream opened; a gateway that reports
    // the rejection inside the stream (an SSE `error` event after HTTP 200) has
    // no HTTP status for it. Classify such a failure by its own payload, so a
    // wrapped size rejection is not vetoed as "status 200" and resent.
    const responseStatus = input.response?.status;
    const failureStatus = responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)
        ? responseStatus
        : undefined;
    const normalized = normalizeLLMError({
        ...(input.thrown !== undefined ? { raw: input.thrown } : {}),
        ...(input.final?.stopReason ? { finishReason: input.final.stopReason } : {}),
        ...(input.final?.errorMessage ? { errorMessage: input.final.errorMessage } : {}),
        ...(failureStatus !== undefined ? { statusCode: failureStatus } : {}),
        explicitAbort: input.final?.stopReason === 'aborted',
    });
    // BYOK retries every pre-output failure because custom gateways report errors
    // inconsistently, but some failures are deterministic: a model safety refusal,
    // or a request the provider rejects as invalid (too many images, or an HTTP
    // 400 `invalid_request_error`). Retrying those only re-sends the same request,
    // repeats (and may re-bill) the rejection and delays the actionable error by
    // the whole backoff window. The deterministic check excludes anything that
    // also looks transient (timeout, network, 408/429/5xx). A context overflow,
    // by tokens or by request bytes, is left to context management as in Pi.
    // Local patch: one classification for every provider, not only BYOK. The
    // strict decision keeps its precise transient reason (timeout, network, 429,
    // overload, 5xx, empty response); the failure it used to fail closed on — an
    // upstream fault no signal matched — is retried as well. Task-level outcomes
    // stay terminal: cancellation, a refusal, a wrong credential, an exhausted
    // usage plan or credits, a deterministic rejection and a context overflow.
    const strictDecision = toLLMRetryDecision(normalized);
    const taskLevelTerminal = normalized.facts.explicitAbort ||
        normalized.facts.signals.has('refusal') ||
        ['auth', 'usage_limit', 'credits_exhausted'].includes(toLLMMetricErrorKind(normalized.facts)) ||
        isLLMDeterministicRequestRejection(normalized) ||
        !!(input.final && isContextOverflow(input.final));
    const decision = strictDecision.retryable || taskLevelTerminal
        ? strictDecision
        : { retryable: true, reason: 'network' };
    if (!decision.retryable) {
        return {
            kind: 'terminal',
            failure: {
                normalized,
                error: publicRetryError(normalized, decision.reason),
                stream: input.stream,
                iterator: input.iterator,
                buffered: input.buffered,
                thrown: input.thrown,
            },
        };
    }
    return {
        kind: 'failure',
        failure: {
            normalized,
            error: publicRetryError(normalized, decision.reason),
            retryReason: decision.reason,
            stream: input.stream,
            iterator: input.iterator,
            buffered: input.buffered,
            thrown: input.thrown,
            retryAfterMs: parseRetryAfterMs(input.response?.headers, input.nowMs()),
        },
    };
}
function isAbortFailure(failure) {
    return failure.normalized.facts.explicitAbort;
}
function discardAttempt(failure) {
    try {
        const closed = failure.iterator?.return?.();
        void Promise.resolve(closed).catch(() => undefined);
    }
    catch {
        // Best-effort provider cleanup must not block a framework retry.
    }
}
function terminalFailure(failure) {
    if (!failure.stream)
        throw asError(failure.thrown);
    if (failure.thrown !== undefined) {
        return throwingReplayStream(failure.buffered, failure.thrown);
    }
    if (!failure.iterator)
        throw new Error('LLM failure stream iterator is unavailable');
    return replayStream(failure.stream, failure.iterator, failure.buffered);
}
function observeTerminalFailure(failure, context) {
    try {
        return observeCallSettlement(terminalFailure(failure), context);
    }
    catch (error) {
        notifyCallSettled(context, error);
        throw error;
    }
}
function observeCallSettlement(source, context) {
    if (!context.input.onCallSettled)
        return source;
    let settled = false;
    const settle = (final, error) => {
        if (settled)
            return;
        settled = true;
        notifyCallSettled(context, error, final);
    };
    const result = Promise.resolve()
        .then(() => source.result())
        .then((final) => {
        settle(final);
        return final;
    }, (error) => {
        settle(undefined, error);
        throw error;
    });
    void result.catch(() => undefined);
    return {
        [Symbol.asyncIterator]() {
            let inner;
            try {
                inner = source[Symbol.asyncIterator]();
            }
            catch (error) {
                settle(undefined, error);
                throw error;
            }
            const iterator = {
                async next(...args) {
                    try {
                        return await inner.next(...args);
                    }
                    catch (error) {
                        settle(undefined, error);
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
}
function notifyCallSettled(context, thrown, final) {
    const observer = context.input.onCallSettled;
    if (!observer)
        return;
    const finalOutcome = classifyCallOutcome(final, thrown, context.signal?.aborted === true);
    const usage = finalOutcome.outcome === 'success' ? callUsage(final) : undefined;
    const event = {
        sessionId: context.input.sessionId,
        turnId: context.input.turnId,
        callId: context.callId,
        scope: context.input.scope,
        provider: String(context.model.provider),
        model: String(context.model.id),
        final: finalOutcome,
        retryTriggered: context.state.retryTriggered,
        ...(context.state.retryReason ? { retryReason: context.state.retryReason } : {}),
        requestAttempts: context.state.requestAttempts,
        ...(finalOutcome.outcome === 'success' && final
            ? { expectedTools: expectedToolsFrom(final) }
            : {}),
        ...(usage ? { usage } : {}),
    };
    try {
        const observed = observer(event);
        void Promise.resolve(observed).catch(() => undefined);
    }
    catch {
        // Final-call observability must never change provider-call behavior.
    }
}
function expectedToolsFrom(final) {
    return final.content.flatMap((block) => block.type === 'toolCall' ? [{ toolCallId: block.id, toolName: block.name }] : []);
}
function classifyCallOutcome(final, thrown, explicitAbort) {
    if (thrown === undefined && final?.stopReason !== 'error' && final?.stopReason !== 'aborted') {
        return { outcome: 'success', errorKind: 'none' };
    }
    const normalized = normalizeLLMError({
        ...(thrown !== undefined ? { raw: thrown } : {}),
        ...(final?.stopReason ? { finishReason: final.stopReason } : {}),
        ...(final?.errorMessage ? { errorMessage: final.errorMessage } : {}),
        explicitAbort: explicitAbort || final?.stopReason === 'aborted',
    });
    const errorKind = toLLMMetricErrorKind(normalized.facts);
    return { outcome: errorKind === 'abort' ? 'abort' : 'error', errorKind };
}
/**
 * Project the provider usage of a successful call into the four raw buckets.
 *
 * Provider payloads are untrusted input, so a missing or non-finite bucket is
 * normalised to zero rather than propagated as NaN. Absent usage yields
 * `undefined` so observers can distinguish "no usage reported" from "zero
 * tokens used".
 */
function callUsage(final) {
    const usage = final?.usage;
    if (!usage)
        return undefined;
    return {
        input: finiteTokens(usage.input),
        output: finiteTokens(usage.output),
        cacheRead: finiteTokens(usage.cacheRead),
        cacheWrite: finiteTokens(usage.cacheWrite),
    };
}
function readProviderUsage(final) {
    try {
        const usage = final?.usage;
        if (!usage)
            return { complete: false };
        const input = readTokenBucket(usage.input);
        const output = readTokenBucket(usage.output);
        const cacheRead = readTokenBucket(usage.cacheRead);
        const cacheWrite = readTokenBucket(usage.cacheWrite);
        return {
            usage: {
                input: input.value,
                output: output.value,
                cacheRead: cacheRead.value,
                cacheWrite: cacheWrite.value,
            },
            // A stream that ended in an error or abort reports only what arrived
            // before it stopped (e.g. the input counted at message start), so its
            // usage is partial even when every bucket is a valid number.
            complete: final?.stopReason !== 'error' &&
                final?.stopReason !== 'aborted' &&
                input.valid &&
                output.valid &&
                cacheRead.valid &&
                cacheWrite.valid,
        };
    }
    catch {
        return { complete: false };
    }
}
function readTokenBucket(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? { value, valid: true }
        : { value: 0, valid: false };
}
function finiteTokens(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
function replayStream(source, iterator, buffered) {
    return {
        async *[Symbol.asyncIterator]() {
            let index = 0;
            while (index < buffered.length) {
                const event = buffered[index];
                index += 1;
                if (event !== undefined)
                    yield event;
            }
            for (;;) {
                const next = await iterator.next();
                if (next.done)
                    return;
                yield next.value;
            }
        },
        result: () => source.result(),
    };
}
function throwingReplayStream(buffered, thrown) {
    return {
        async *[Symbol.asyncIterator]() {
            let index = 0;
            while (index < buffered.length) {
                const event = buffered[index];
                index += 1;
                if (event !== undefined)
                    yield event;
            }
            throw thrown;
        },
        async result() {
            throw thrown;
        },
    };
}
function commitsOutput(event) {
    if (event.type === 'text_delta' ||
        event.type === 'thinking_delta' ||
        event.type === 'toolcall_delta') {
        return event.delta.length > 0;
    }
    if (event.type === 'text_end' || event.type === 'thinking_end')
        return event.content.length > 0;
    if (event.type === 'toolcall_end')
        return true;
    return 'partial' in event && hasCommittedContent(event.partial);
}
function hasCommittedContent(message) {
    return message.content.some((block) => {
        if (block.type === 'text')
            return block.text.length > 0;
        if (block.type === 'thinking')
            return block.thinking.length > 0;
        return block.type === 'toolCall';
    });
}
function isFailureMessage(message) {
    return message.stopReason === 'error' || message.stopReason === 'aborted';
}
function resolvePolicy(policy) {
    return { ...DEFAULT_LLM_RETRY_POLICY, ...(policy ?? {}) };
}
function retryDelayMs(retryAfterMs, retryAttempt, policy, random) {
    if (retryAfterMs !== undefined)
        return Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs));
    // Local patch: unstable upstreams retry on the fixed `baseDelayMs` cadence
    // (no exponential growth, no jitter); a server-directed Retry-After still
    // wins above.
    return policy.baseDelayMs;
}
function clampRandom(value) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
function parseRetryAfterMs(headers, nowMs) {
    if (!headers)
        return undefined;
    const entries = Object.entries(headers);
    const retryAfterMs = entries.find(([name]) => name.toLowerCase() === 'retry-after-ms')?.[1];
    const parsedMillis = retryAfterMs === undefined ? undefined : Number(retryAfterMs);
    if (parsedMillis !== undefined && Number.isFinite(parsedMillis))
        return Math.max(0, parsedMillis);
    const retryAfter = entries.find(([name]) => name.toLowerCase() === 'retry-after')?.[1];
    if (!retryAfter)
        return undefined;
    const parsedSeconds = Number(retryAfter);
    if (Number.isFinite(parsedSeconds))
        return Math.max(0, parsedSeconds * 1_000);
    const parsedDate = Date.parse(retryAfter);
    return Number.isNaN(parsedDate) ? undefined : Math.max(0, parsedDate - nowMs);
}
function publicRetryError(normalized, reason) {
    const protocol = toLLMProtocolClassification(normalized);
    return {
        reason,
        ...(protocol ? { code: protocol.code } : {}),
        message: PUBLIC_ERROR_MESSAGES[reason],
    };
}
async function notify(observer, event) {
    try {
        await observer?.(event);
    }
    catch {
        // Observability must never change provider-call correctness.
    }
}
function abortableSleep(delayMs, signal) {
    if (signal?.aborted)
        return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (signal)
                reject(abortError(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
function abortError(signal) {
    return signal.reason instanceof Error ? signal.reason : new Error('LLM retry cancelled');
}
function asError(value) {
    return value instanceof Error ? value : new Error(String(value ?? 'LLM request failed'));
}
function defaultCallId() {
    return (globalThis.crypto?.randomUUID?.() ??
        `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
}
//# sourceMappingURL=llm-retry.js.map