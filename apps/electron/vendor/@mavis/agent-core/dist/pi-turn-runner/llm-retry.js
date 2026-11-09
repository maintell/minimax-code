import { isContextOverflow, } from '@earendil-works/pi-ai';
import { isLLMDeterministicRequestRejection, normalizeLLMError, toLLMMetricErrorKind, toLLMProtocolClassification, toLLMRetryDecision, } from '@mavis/shared/llm-error-classifier';
import { runWithLLMCallLifecycle, } from './llm-call-lifecycle.js';
import { LLMReplyLoopGuard, llmReplyLoopMessage, } from './llm-reply-loop-guard.js';
import { withLLMStreamFailure } from './llm-stream-failure.js';
function isByokProvider(provider) {
    return provider === 'minimax_api' || provider.startsWith('custom_provider:');
}
/** Symbol-keyed identity shared by physical attempts of one logical call. */
export const LLM_RETRY_CALL_IDENTITY = Symbol('mavis.llmRetryCallIdentity');
/** Required synchronous admission hook, called before each physical request; failures stop dispatch. */
export const LLM_RETRY_BEFORE_REQUEST = Symbol('mavis.llmRetryBeforeRequest');
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
export const DEFAULT_LLM_REPLY_GUARD_POLICY = {
    emptyRetries: 2,
    holdReasoning: false,
    holdReasoningMaxMs: 4 * 60_000,
    holdReasoningMaxEvents: 20_000,
    holdReasoningMaxChars: 1 << 20,
    loopGuard: true,
    loopRetries: 1,
};
/** A hold never runs into the call's own deadline: it is released this long before it. */
const HOLD_DEADLINE_MARGIN_MS = 1_000;
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
function __mavisRetryTrace(event) {
    try {
        const proc = globalThis.process;
        const fs = proc?.getBuiltinModule?.('node:fs');
        if (!fs) return;
        const home = proc?.env?.USERPROFILE || proc?.env?.HOME;
        if (!home) return;
        const dir = home + '/.minimax/v2/observability';
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(dir + '/llm-retry-trace.jsonl', JSON.stringify({ at: new Date().toISOString(), pid: proc?.pid, ...event }) + '\n');
    }
    catch {
        // Observability must never change provider behaviour.
    }
}
/**
 * Local patch: resume a response that died after part of it had already been
 * handed to the caller. Re-sending the request would duplicate the visible
 * output, so the normal retry path cannot be reused; the only correct
 * continuation is a fresh call told to pick up where the truncated text
 * stopped. Its events are NOT streamed as they arrive (a second start/textStart
 * would collide with the open content block): its text is appended in one delta
 * once it completes, and a tool call aborts the resume because a second tool
 * block cannot be merged into the committed message.
 */
function __mavisResumeStream(input) {
    const { inner, model, context, options, source } = input;
    const signal = options?.signal;
    const delayMs = Number(globalThis.process?.env?.MAVIS_RESUME_DELAY_MS ?? 3000);
    const directive = '（上一段输出因链路中断被截断：请从断点继续，不要重复已经输出的内容，也不要重新解释。）';
    let text = '';
    let sawToolcall = false;
    let finalMessage;
    let started = false;
    let resolveSettled;
    let rejectSettled;
    const settledPromise = new Promise((resolve, reject) => {
        resolveSettled = resolve;
        rejectSettled = reject;
    });
    const abortReason = () => (signal && signal.reason instanceof Error ? signal.reason : new Error('LLM retry cancelled'));
    const wait = (ms) => new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
            reject(abortReason());
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            if (signal)
                signal.removeEventListener('abort', onAbort);
            reject(abortReason());
        };
        const timer = setTimeout(() => {
            if (signal)
                signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        if (signal)
            signal.addEventListener('abort', onAbort, { once: true });
    });
    const note = (event) => __mavisRetryTrace(event);
    async function resumeOnce(continueFromText) {
        const messages = Array.isArray(context && context.messages) ? context.messages : [];
        const resumeContext = continueFromText
            ? {
                ...(context || {}),
                messages: [
                    ...messages,
                    { role: 'assistant', content: [{ type: 'text', text }] },
                    { role: 'user', content: [{ type: 'text', text: directive }] },
                ],
            }
            // Nothing visible was committed, so there is no break point to
            // continue from: re-issue the original request unchanged (a plain
            // retry, which is what the pre-output path would have done).
            : { ...(context || {}) };
        const attempt = await inner(model, resumeContext, { ...(options || {}), maxRetries: 0 });
        let tail = '';
        const iterable = attempt && typeof attempt[Symbol.asyncIterator] === 'function' ? attempt : undefined;
        if (iterable) for await (const event of iterable) {
            if (!event)
                continue;
            if (event.type === 'text_delta') {
                tail += event.delta || '';
                continue;
            }
            if (event.type === 'text_end')
                continue;
            if (event.type === 'start' || event.type === 'text_start' || event.type === 'done')
                continue;
            if (event.type === 'error')
                throw new Error('resume attempt failed');
            if (typeof event.type === 'string' && event.type.indexOf('toolcall') === 0) {
                sawToolcall = true;
                throw new Error('resume produced a tool call');
            }
        }
        const final = await (attempt && typeof attempt.result === 'function' ? attempt.result() : undefined);
        if (!final || final.stopReason === 'error')
            throw new Error('resume attempt ended in failure');
        if (final.stopReason === 'aborted')
            throw abortReason();
        text = text + tail;
        finalMessage = final;
    }
    const stream = {
        async *[Symbol.asyncIterator]() {
            started = true;
            const iterator = source[Symbol.asyncIterator]();
            let failure;
            for (;;) {
                let next;
                try {
                    next = await iterator.next();
                }
                catch (thrown) {
                    failure = thrown;
                    break;
                }
                if (next.done)
                    break;
                const event = next.value;
                if (event.type === 'text_delta')
                    text += event.delta || '';
                else if (event.type === 'text_end')
                    text = text || String(event.content || '');
                else if (typeof event.type === 'string' && event.type.indexOf('toolcall') === 0)
                    sawToolcall = true;
                yield event;
            }
            if (failure === undefined) {
                let settled;
                try {
                    settled = await source.result();
                }
                catch (thrown) {
                    failure = thrown;
                }
                if (failure === undefined) {
                    if (settled && settled.stopReason === 'error') {
                        failure = new Error(String(settled.errorMessage || 'stream ended in error'));
                    }
                    else {
                        finalMessage = settled;
                        resolveSettled(settled);
                        return;
                    }
                }
            }
            if (sawToolcall) {
                rejectSettled(failure);
                throw failure;
            }
            const baseText = text;
            note({ event: 'resume_start', chars: baseText.length });
            for (let round = 1;; round += 1) {
                const snapshot = text;
                try {
                    if (signal && signal.aborted)
                        throw abortReason();
                    await resumeOnce(text.length > 0);
                    note({ event: 'resume_ok', round, chars: text.length });
                    break;
                }
                catch (error) {
                    if ((signal && signal.aborted) || sawToolcall) {
                        // Surface the provider's original failure, not this
                        // wrapper's internal reason: the caller decides what the
                        // user sees, and "resume produced a tool call" is noise.
                        note({ event: 'resume_stop', round, reason: signal && signal.aborted ? 'aborted' : 'toolcall', detail: String(error && error.message ? error.message : error).slice(0, 200) });
                        rejectSettled(failure);
                        throw failure;
                    }
                    text = snapshot;
                    note({ event: 'resume_retry', round, message: String(error && error.message ? error.message : error).slice(0, 200) });
                    await wait(delayMs);
                }
            }
            const merged = {
                role: 'assistant',
                timestamp: Date.now(),
                ...(finalMessage || {}),
                stopReason: 'stop',
                content: [{ type: 'text', text }],
            };
            const tail = text.slice(baseText.length);
            if (tail.length > 0)
                yield { type: 'text_delta', contentIndex: 0, delta: tail, partial: merged };
            yield { type: 'text_end', contentIndex: 0, content: text, partial: merged };
            yield { type: 'done', reason: 'stop', message: merged };
            resolveSettled(merged);
        },
        result() {
            if (!started) {
                started = true;
                void (async () => {
                    try {
                        for await (const ignored of stream) {
                            void ignored;
                        }
                    }
                    catch (error) {
                        rejectSettled(error);
                    }
                })();
            }
            return settledPromise;
        },
    };
    return stream;
}
/** Add framework-owned transport retry to a provider StreamFn. Hosts opt in explicitly. */
export function withLLMRetry(inner, input) {
    return (async (model, context, options) => {
        const callId = input.generateCallId?.() ?? defaultCallId();
        __mavisRetryTrace({ event: 'call_start', scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, provider: String(model.provider), model: String(model.id), callId });
        const identity = {};
        const state = { retryTriggered: false, requestAttempts: 0 };
        if (!input.lifecycle)
            return createRetryLoop(inner, input, callId, identity, state)(model, context, options);
        const callerSignal = options?.signal ?? new AbortController().signal;
        // The host contract is absolute Unix ms, independent of a test/observer clock.
        // Short auxiliary requests must not acquire a fresh, longer budget during admission/recovery.
        const requestedMs = options?.timeoutMs;
        const timeoutMs = typeof requestedMs === 'number' && Number.isFinite(requestedMs) && requestedMs > 0
            ? requestedMs
            : Infinity;
        // Admission (and the host's recovery) is bounded by the retry budget, including the per-attempt
        // admission the lease runs before it sends (an account's queue for a free slot). The request
        // itself is not: once sent, only the caller's own timeout bounds it, as without a host lease
        // (agent-core's first-event and idle watchdogs bound the wait for a reply).
        const deadlineAt = Date.now() + Math.floor(Math.min(resolvePolicy(input.policy).maxRetryElapsedMs, timeoutMs));
        const hardDeadlineAt = Number.isFinite(timeoutMs)
            ? Date.now() + Math.floor(timeoutMs)
            : undefined;
        const budget = createRetryBudget(callerSignal, deadlineAt);
        // The lease calls this once its admission is done and the request goes out.
        const sent = (sentModel, sentContext, sentOptions) => {
            budget.arm(hardDeadlineAt);
            return inner(sentModel, sentContext, sentOptions);
        };
        const settlement = { input, model, callId, state, signal: callerSignal };
        try {
            const stream = await runWithLLMCallLifecycle(input.lifecycle, {
                identity,
                callId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                scope: input.scope,
                signal: budget.signal,
                deadlineAt,
            }, async (lease) => createRetryLoop(lease.wrapAttempt(sent), input, callId, identity, state, lease, hardDeadlineAt, budget, deadlineAt)(model, context, { ...options, signal: lease.signal }));
            // Required cleanup settles before the logical outcome is published.
            return observeCallSettlement(stream, settlement);
        }
        catch (error) {
            if (budget.expired() && !callerSignal.aborted)
                state.terminalErrorKind = 'timeout';
            notifyCallSettled(settlement, error);
            throw error;
        }
        finally {
            budget.stop();
        }
    });
}
function createRetryLoop(inner, input, callId, callIdentity, state, lease, 
/** With a host lease: the caller's own timeout, the only bound on a request in flight. */
hardDeadlineAt, budget, 
/** With a host lease: the bound on the first attempt's admission (the retry budget). */
admissionDeadlineAt) {
    const policy = resolvePolicy(input.policy);
    const replyGuard = resolveReplyGuardPolicy(input.replyGuard);
    const nowMs = input.nowMs ?? Date.now;
    const random = input.random ?? Math.random;
    const sleep = input.sleep ?? abortableSleep;
    // Request accounting (upstream): the agent scope's admission lifecycle, or a
    // counting-only recorder for every non-title scope.
    const lifecycle = input.scope === 'agent' && input.requestLifecycle
        ? input.requestLifecycle
        : input.scope !== 'title' && input.usageRecorder
            ? recordingLifecycle(input.usageRecorder, input.scope)
            : undefined;
    return (async (model, originalContext, options) => {
        // Admission may stop the request before any transport: no call settles then.
        const request = await admitRequest(lifecycle, callId, originalContext);
        const { context } = request;
        // With a host lease, only the outer cleanup wrapper may publish settlement.
        const settlement = {
            input: lease ? { ...input, onCallSettled: undefined } : input,
            model,
            callId,
            state,
            signal: options?.signal,
        };
        let retryStartedAtMs;
        // With a host lease: retries and recovery share the retry budget from the first failure.
        let retryDeadlineAt;
        const deadlineAt = () => retryDeadlineAt ?? hardDeadlineAt;
        let requestAttempt = 1;
        // Asks spent on empty and looping replies; each is also a retry of the policy's budget.
        let emptyRetries = 0;
        let loopRetries = 0;
        const event = (status, error) => ({
            sessionId: input.sessionId,
            turnId: input.turnId,
            callId,
            scope: input.scope,
            status,
            retryAttempt: requestAttempt - 1,
            maxRetries: policy.maxRetries,
            requestAttempt,
            ...(error ? { error } : {}),
        });
        try {
            while (requestAttempt <= policy.maxRetries + 1) {
                if (options?.signal?.aborted)
                    throw abortError(options.signal);
                const attemptDeadlineAt = deadlineAt();
                if (attemptDeadlineAt !== undefined && Date.now() >= attemptDeadlineAt)
                    throw retryTimeout();
                // The lease's admission for this attempt is bounded by the retry budget; the wrapped inner
                // re-arms the caller's own timeout once the request is sent.
                budget?.arm(retryDeadlineAt ?? admissionDeadlineAt);
                state.terminalErrorKind = undefined;
                const beforeRequest = options?.[LLM_RETRY_BEFORE_REQUEST];
                beforeRequest?.(requestAttempt);
                await lifecycle?.beforeAttempt({ callId, requestAttempt });
                state.requestAttempts = requestAttempt;
                const preflight = await preflightAttempt(inner, model, context, options, nowMs, callIdentity, isByokProvider(model.provider), requestAttempt, request.observeAttempt(requestSettledObserver(options)), budget, {
                    policy: replyGuard,
                    emptyRetry: emptyRetries < replyGuard.emptyRetries && requestAttempt <= policy.maxRetries,
                    loopRetry: loopRetries < replyGuard.loopRetries && requestAttempt <= policy.maxRetries,
                    ...(attemptDeadlineAt !== undefined ? { deadlineAt: attemptDeadlineAt } : {}),
                });
                if (options?.signal?.aborted) {
                    if (preflight.kind !== 'committed') {
                        if (requestAttempt > 1)
                            await notify(input.observer, event('cancelled', preflight.failure.error));
                        return request.settleWith(await request.guardThrow(options?.signal, () => observeTerminalFailure(preflight.failure, settlement)), options?.signal);
                    }
                    throw abortError(options.signal);
                }
                __mavisRetryTrace({
                    event: 'attempt_result',
                    scope: input.scope,
                    provider: String(model.provider),
                    callId,
                    attempt: requestAttempt,
                    kind: preflight.kind,
                    reason: preflight.kind === 'committed' ? undefined : preflight.failure?.error?.reason,
                    buffered: preflight.kind === 'committed' ? 0 : (preflight.failure?.buffered?.length ?? 0),
                    message: String((preflight.kind === 'committed' ? '' : preflight.failure?.error?.message) ?? '').slice(0, 200),
                });
                if (preflight.kind === 'committed') {
                    budget?.stop();
                    if (requestAttempt > 1)
                        await notify(input.observer, event('recovered'));
                    return request.settleWith(observeCallSettlement(preflight.stream, settlement), options?.signal);
                }
                const failure = preflight.failure;
                const owned = failure.streamFailure;
                // A reply this layer ends on its own (a loop cut) is not the host's to judge.
                const hostDecision = owned && !owned.retry
                    ? undefined
                    : await lease?.classifyFailure?.({
                        ...(failure.thrown !== undefined ? { thrown: failure.thrown } : {}),
                        ...(failure.final !== undefined ? { final: failure.final } : {}),
                        ...(failure.response !== undefined ? { response: failure.response } : {}),
                    });
                const ownDecision = {
                    kind: preflight.kind === 'failure' ? 'retry' : 'terminal',
                    errorKind: failure.error.reason,
                    ...(preflight.kind === 'failure' ? { retryReason: preflight.failure.retryReason } : {}),
                    retryAfterMs: failure.retryAfterMs,
                };
                // An empty or looping reply came whole over a healthy transport, which a provider
                // classifier only reads as a bad request: the host may move it to another account
                // (`retry`), and any other verdict leaves it to this layer's own bounded retry.
                const decision = owned
                    ? owned.retry && hostDecision?.kind === 'retry'
                        ? hostDecision
                        : ownDecision
                    : (hostDecision ?? ownDecision);
                if (hostDecision && !owned) {
                    failure.error = publicRetryError(failure.normalized, decision.errorKind);
                    state.terminalErrorKind = decision.errorKind;
                }
                const failureAtMs = nowMs();
                retryStartedAtMs ??= failureAtMs;
                if (budget && retryDeadlineAt === undefined) {
                    retryDeadlineAt = Math.min(hardDeadlineAt ?? Infinity, Date.now() + policy.maxRetryElapsedMs);
                    budget.arm(retryDeadlineAt);
                }
                const delayMs = retryDelayMs(decision.retryAfterMs ?? failure.retryAfterMs, requestAttempt, policy, random);
                const expired = retryDeadlineAt !== undefined
                    ? Date.now() + delayMs >= retryDeadlineAt
                    : failureAtMs + delayMs - retryStartedAtMs > policy.maxRetryElapsedMs;
                const cannotRecover = decision.kind === 'recover' && (!lease?.recover || retryDeadlineAt === undefined);
                if (isAbortFailure(failure) ||
                    decision.kind === 'terminal' ||
                    cannotRecover ||
                    requestAttempt > policy.maxRetries ||
                    expired) {
                    // An empty reply handed over as it came ends the call with that reply, not a failure.
                    const handedOver = owned?.kind === 'llm_empty_response';
                    if (handedOver) {
                        if (requestAttempt > 1)
                            await notify(input.observer, event('recovered'));
                    }
                    else if (preflight.kind === 'failure' || requestAttempt > 1) {
                        await notify(input.observer, event(isAbortFailure(failure) ? 'cancelled' : 'exhausted', failure.error));
                    }
                    return request.settleWith(await request.guardThrow(options?.signal, () => observeTerminalFailure(failure, settlement)), options?.signal);
                }
                // A failed attempt must release transport and credential resources before recovery.
                await discardAttempt(failure);
                if (options?.signal?.aborted)
                    throw abortError(options.signal);
                if (decision.kind === 'recover' && lease?.recover && retryDeadlineAt !== undefined) {
                    if (Date.now() >= retryDeadlineAt)
                        throw retryTimeout();
                    await lease.recover({ signal: lease.signal, deadlineAt: retryDeadlineAt });
                }
                if (options?.signal?.aborted)
                    throw abortError(options.signal);
                if (retryDeadlineAt !== undefined && Date.now() + delayMs >= retryDeadlineAt)
                    throw retryTimeout();
                state.retryTriggered = true;
                if (owned?.kind === 'llm_empty_response')
                    emptyRetries += 1;
                if (owned?.kind === 'llm_reply_loop')
                    loopRetries += 1;
                // Credential recovery has no transport retry reason; never inherit BYOK's network fallback.
                state.retryReason ??= decision.retryReason;
                await notify(input.observer, {
                    ...event('waiting', failure.error),
                    retryAttempt: requestAttempt,
                    requestAttempt: requestAttempt + 1,
                    delayMs,
                    nextRetryAtMs: nowMs() + delayMs,
                });
                try {
                    await sleep(delayMs, options?.signal);
                }
                catch (error) {
                    await notify(input.observer, {
                        ...event('cancelled', failure.error),
                        retryAttempt: requestAttempt,
                        requestAttempt: requestAttempt + 1,
                    });
                    throw error;
                }
                requestAttempt += 1;
            }
            throw new Error('LLM retry loop ended without a provider result');
        }
        catch (error) {
            notifyCallSettled(settlement, error);
            await request.settleThrown(error, options?.signal);
            throw error;
        }
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
const NO_REPLY_GUARD = {
    policy: { ...DEFAULT_LLM_REPLY_GUARD_POLICY, emptyRetries: 0, loopGuard: false, loopRetries: 0 },
    emptyRetry: false,
    loopRetry: false,
};
async function preflightAttempt(inner, model, context, options, nowMs, callIdentity, retryAllErrors, requestAttempt, onRequestSettled, budget, guard = NO_REPLY_GUARD) {
    let response;
    const callerOnResponse = options?.onResponse;
    // A reply cut for looping must also stop the provider request (it would otherwise run to its
    // output limit): this attempt's own signal, linked to the caller's.
    const stopController = guard.policy.loopGuard ? new AbortController() : undefined;
    const attemptOptions = {
        ...(options ?? {}),
        ...(stopController
            ? {
                signal: options?.signal
                    ? AbortSignal.any([options.signal, stopController.signal])
                    : stopController.signal,
            }
            : {}),
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
    const loop = guard.policy.loopGuard ? new LLMReplyLoopGuard() : undefined;
    const hold = guard.policy.holdReasoning
        ? new ReasoningHold(guard.policy, guard.deadlineAt)
        : undefined;
    let lastPartial;
    const stopProvider = () => {
        if (stopController && !stopController.signal.aborted)
            stopController.abort(replyLoopStopReason());
        releaseIterator(iterator);
    };
    const cutFinal = (trip) => withLLMStreamFailure(detachedPartial(lastPartial, model), 'llm_reply_loop', llmReplyLoopMessage(trip), { channel: trip.reasoning ? 'reasoning' : 'text', window: trip.window, runOn: trip.runOn });
    const commit = (pending) => {
        budget?.stop();
        return {
            kind: 'committed',
            stream: __mavisResumeStream({
                inner,
                model,
                context,
                options,
                source: observeRequestSettlement(replayStream(stream, iterator, buffered, {
                ...(pending ? { pending } : {}),
                ...(loop
                    ? {
                        // After the commit boundary a loop is cut with an error; nothing is asked again.
                        guard: (event) => {
                            const partial = partialOf(event);
                            if (partial)
                                lastPartial = partial;
                            const trip = loop.feed(event);
                            return trip ? cutFinal(trip) : undefined;
                        },
                        stop: stopProvider,
                    }
                    : {}),
            }), requestAttempt, onRequestSettled, options?.signal),
            }),
        };
    };
    const emptyFailure = (final) => ownedFailure({
        kind: 'llm_empty_response',
        final: withLLMStreamFailure(final, 'llm_empty_response', EMPTY_REPLY_MESSAGE),
        retry: true,
        // When nobody asks again, the empty reply goes on exactly as the provider sent it.
        handover: () => replayStream(stream, iterator, buffered),
        response,
        stream,
        iterator,
        buffered,
    });
    for (;;) {
        let next;
        try {
            const pending = iterator.next();
            next = hold?.active ? await hold.race(pending) : await pending;
            // Reasoning held as long as it may be: what is held goes now, and the reply commits.
            if (next === HOLD_EXPIRED)
                return commit(pending);
        }
        catch (thrown) {
            notifyRequestSettled(onRequestSettled, requestAttempt, undefined, thrown, options?.signal);
            return failureResult({ thrown, response, stream, iterator, buffered, nowMs, retryAllErrors });
        }
        if (next.done) {
            try {
                const final = await stream.result();
                notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
                if (isFailureMessage(final)) {
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
                if (guard.emptyRetry && isEmptyReply(final))
                    return emptyFailure(final);
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
        const event = next.value;
        buffered.push(event);
        const partial = partialOf(event);
        if (partial)
            lastPartial = partial;
        if (event.type === 'error') {
            notifyRequestSettled(onRequestSettled, requestAttempt, event.error, undefined, options?.signal);
            return failureResult({
                final: event.error,
                response,
                stream,
                iterator,
                buffered,
                nowMs,
                retryAllErrors,
            });
        }
        const trip = loop?.feed(event);
        if (trip) {
            // Nothing of this reply was released yet: one whose held reasoning looped before it said
            // anything is asked again; any other loop ends the reply with its error.
            const final = cutFinal(trip);
            stopProvider();
            notifyRequestSettled(onRequestSettled, requestAttempt, final, undefined, options?.signal);
            const retry = guard.loopRetry && trip.reasoning && !loop.spoke;
            return ownedFailure({
                kind: 'llm_reply_loop',
                final,
                retry,
                handover: () => cutStream(buffered, final),
                response,
                stream,
                iterator,
                buffered,
            });
        }
        if (event.type === 'done' && guard.emptyRetry && isEmptyReply(event.message)) {
            notifyRequestSettled(onRequestSettled, requestAttempt, event.message, undefined, options?.signal);
            return emptyFailure(event.message);
        }
        // A visible delta is the retry commit boundary for every provider. Once
        // callers can observe output, silently replacing the physical request
        // would either buffer the whole response or replay duplicate content.
        // BYOK keeps its broader pre-output retry classification, but a later
        // stream failure must stay on the already-committed attempt. Held
        // reasoning is not visible yet: it commits with the first text or tool
        // call, or once the hold reaches its bounds.
        if (commitsOutput(event, hold !== undefined) || (!retryAllErrors && event.type === 'done')) {
            return commit();
        }
        if (hold && commitsOutput(event)) {
            hold.note(event);
            if (hold.over(buffered.length))
                return commit();
        }
    }
}
/** APIs whose every whole reply counts its tokens. */
const REPLIES_COUNTED = new Set([
    'anthropic-messages',
    'openai-responses',
    'openai-codex-responses',
]);
const EMPTY_REPLY_MESSAGE = 'LLM provider returned an empty response: the reply ended without text or a tool call';
/**
 * A reply that ended `stop` with no text and no tool call: reasoning alone
 * says nothing the agent can act on. A Messages API empty
 * `end_turn` that counted its prompt is the model's answer, and stays one. Chat Completions, which most subscription transports
 * (Gemini's among them) are translated to, fails on any empty stop.
 */
function isEmptyReply(final) {
    // A custom stream may end with a malformed message: never read that as an empty reply.
    if (!final || typeof final !== 'object' || !Array.isArray(final.content))
        return false;
    if (final.stopReason !== 'stop')
        return false;
    const content = final.content;
    if (content.some((block) => block.type === 'toolCall' || (block.type === 'text' && block.text.trim().length > 0)))
        return false;
    // Messages and Responses count every whole reply; one that counted its tokens and said
    // nothing is the model's answer (a turn ending after a tool result), not a lost reply.
    if (REPLIES_COUNTED.has(String(final.api)) && countedUsage(final))
        return false;
    return true;
}
function countedUsage(final) {
    const usage = final.usage;
    if (!usage)
        return false;
    return (finiteTokens(usage.input) +
        finiteTokens(usage.output) +
        finiteTokens(usage.cacheRead) +
        finiteTokens(usage.cacheWrite) >
        0);
}
/** A failure decided by this layer on a reply the provider sent (empty or looping). */
function ownedFailure(input) {
    const normalized = normalizeLLMError({
        ...(input.final.errorMessage ? { errorMessage: input.final.errorMessage } : {}),
    });
    const reason = input.kind === 'llm_empty_response' ? 'empty_response' : 'unknown';
    const failure = {
        normalized,
        error: publicRetryError(normalized, reason),
        stream: input.stream,
        iterator: input.iterator,
        buffered: input.buffered,
        final: input.final,
        ...(input.response ? { response: input.response } : {}),
        streamFailure: { kind: input.kind, retry: input.retry, handover: input.handover },
    };
    return input.retry
        ? // Shown as an interrupted connection being retried, as a dropped stream is.
            { kind: 'failure', failure: { ...failure, retryReason: 'network' } }
        : { kind: 'terminal', failure };
}
const HOLD_EXPIRED = Symbol('llm-reasoning-hold-expired');
/**
 * Reasoning held back before the first text or tool call. It ends at its time bound, its event or
 * character bound, or ahead of the call's own deadline, whichever comes first.
 */
class ReasoningHold {
    policy;
    deadlineAt;
    startedAt;
    chars = 0;
    constructor(policy, deadlineAt) {
        this.policy = policy;
        this.deadlineAt = deadlineAt;
    }
    get active() {
        return this.startedAt !== undefined;
    }
    note(event) {
        this.startedAt ??= Date.now();
        if (event.type === 'thinking_delta')
            this.chars += event.delta.length;
    }
    over(heldEvents) {
        return (heldEvents >= this.policy.holdReasoningMaxEvents ||
            this.chars >= this.policy.holdReasoningMaxChars ||
            Date.now() >= this.releaseAt());
    }
    async race(pending) {
        const wait = this.releaseAt() - Date.now();
        if (wait <= 0)
            return HOLD_EXPIRED;
        let timer;
        const expired = new Promise((resolve) => {
            timer = setTimeout(() => resolve(HOLD_EXPIRED), wait);
            timer.unref?.();
        });
        try {
            return await Promise.race([pending, expired]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    releaseAt() {
        const held = (this.startedAt ?? Date.now()) + this.policy.holdReasoningMaxMs;
        return this.deadlineAt === undefined
            ? held
            : Math.min(held, this.deadlineAt - HOLD_DEADLINE_MARGIN_MS);
    }
}
function replyLoopStopReason() {
    const error = new Error('LLM reply stopped: stuck in a loop');
    error.name = 'AbortError';
    return error;
}
function partialOf(event) {
    if (event.type === 'done')
        return event.message;
    if (event.type === 'error')
        return event.error;
    return event.partial;
}
/** Detach from the provider's mutable partial so a late write cannot rewrite the cut message. */
function detachedPartial(partial, model) {
    if (partial) {
        return { ...partial, content: partial.content.map((block) => ({ ...block })) };
    }
    return {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        timestamp: Date.now(),
    };
}
/** Ask the inner stream to stop without waiting on one that may never settle. */
function releaseIterator(iterator) {
    void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
}
/** What came of a reply before its loop was found, then its error. */
function cutStream(buffered, final) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const event of buffered)
                yield event;
            yield { type: 'error', reason: 'error', error: final };
        },
        result: async () => final,
    };
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
            ...(providerUsage.reportedUsage ? { reportedUsage: providerUsage.reportedUsage } : {}),
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
    const result = settleResult(source, settle);
    observe(result);
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
async function settleResult(source, settle) {
    try {
        const final = await source.result();
        settle(final);
        return final;
    }
    catch (error) {
        settle(undefined, error);
        throw error;
    }
}
async function observe(promise) {
    try {
        await promise;
    }
    catch {
        // The consumer-facing result retains the rejection.
    }
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
                final: input.final,
                response: input.response,
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
            final: input.final,
            response: input.response,
            retryAfterMs: parseRetryAfterMs(input.response?.headers, input.nowMs()),
        },
    };
}
function isAbortFailure(failure) {
    return failure.normalized.facts.explicitAbort;
}
async function discardAttempt(failure) {
    if (!failure.iterator?.return)
        return;
    await failure.iterator.return();
}
function terminalFailure(failure) {
    if (failure.streamFailure)
        return failure.streamFailure.handover();
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
    const result = settleResult(source, settle);
    observe(result);
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
    if (!observer || context.state.settled)
        return;
    context.state.settled = true;
    let finalOutcome = classifyCallOutcome(final, thrown, context.signal?.aborted === true);
    if (finalOutcome.outcome !== 'success' &&
        !context.signal?.aborted &&
        context.state.terminalErrorKind) {
        const errorKind = context.state.terminalErrorKind;
        finalOutcome = { outcome: errorKind === 'abort' ? 'abort' : 'error', errorKind };
    }
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
    observeObserver(observer, event);
}
async function observeObserver(observer, event) {
    try {
        await observer(event);
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
        const totalTokens = readTokenBucket(usage.totalTokens);
        return {
            reportedUsage: {
                ...(input.valid ? { input: input.value } : {}),
                ...(output.valid ? { output: output.value } : {}),
                ...(cacheRead.valid ? { cacheRead: cacheRead.value } : {}),
                ...(cacheWrite.valid ? { cacheWrite: cacheWrite.value } : {}),
                ...(totalTokens.valid ? { totalTokens: totalTokens.value } : {}),
            },
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
function replayStream(source, iterator, buffered, extra = {}) {
    if (!extra.guard && !extra.pending) {
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
    return guardedReplay(source, iterator, buffered, extra);
}
/**
 * Replay through one reader that both the iterator and `result()` drive, so a
 * loop cut decides the result even for a consumer (or a settlement observer)
 * that asks for the result before, or instead of, reading the events. Events
 * are queued until read; an early `return()` stops the reader and releases the
 * provider stream.
 */
function guardedReplay(source, iterator, buffered, extra) {
    const queue = [...buffered];
    let finished = false;
    let cancelled = false;
    let failure;
    let cut;
    let wake;
    let pumping;
    const wakeReader = () => {
        const waiter = wake;
        wake = undefined;
        waiter?.();
    };
    const pump = () => {
        pumping ??= (async () => {
            try {
                let pending = extra.pending;
                for (;;) {
                    if (cancelled)
                        return;
                    const next = pending ? await pending : await iterator.next();
                    pending = undefined;
                    if (cancelled || next.done)
                        return;
                    const final = extra.guard?.(next.value);
                    if (final) {
                        cut = final;
                        extra.stop?.();
                        queue.push({ type: 'error', reason: 'error', error: final });
                        return;
                    }
                    queue.push(next.value);
                    wakeReader();
                }
            }
            catch (error) {
                failure = { error };
            }
            finally {
                finished = true;
                wakeReader();
            }
        })();
        return pumping;
    };
    return {
        async *[Symbol.asyncIterator]() {
            void pump();
            try {
                for (;;) {
                    const event = queue.shift();
                    if (event !== undefined) {
                        yield event;
                        continue;
                    }
                    if (finished) {
                        if (failure)
                            throw failure.error;
                        return;
                    }
                    await new Promise((resolve) => {
                        wake = resolve;
                    });
                }
            }
            finally {
                if (!finished) {
                    cancelled = true;
                    releaseIterator(iterator);
                }
            }
        },
        async result() {
            await pump();
            return cut ?? source.result();
        },
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
function commitsOutput(event, holdReasoning = false) {
    // Local patch: only answer text and a COMPLETED tool call end the retry
    // window. Reasoning deltas are discarded when an attempt is retried, and a
    // tool call that is still streaming its arguments was never executed — the
    // caller only receives it once the block ends — so counting either as
    // committed pushed a retryable failure into the resume path with an empty
    // prefix (measured: resume_start chars=0). The parameter stays in the
    // signature because the reply guard passes it in.
    void holdReasoning;
    if (event.type === 'text_delta' || event.type === 'toolcall_delta')
        return event.delta.length > 0;
    if (event.type === 'text_end')
        return event.content.length > 0;
    if (event.type === 'toolcall_end')
        return true;
    if (event.type === 'thinking_delta' || event.type === 'thinking_end')
        return false;
    return 'partial' in event && hasCommittedContent(event.partial);
}
function hasCommittedContent(message) {
    return message.content.some((block) => block.type === 'text' && block.text.length > 0);
}
function isFailureMessage(message) {
    return message.stopReason === 'error' || message.stopReason === 'aborted';
}
function resolvePolicy(policy) {
    return { ...DEFAULT_LLM_RETRY_POLICY, ...(policy ?? {}) };
}
function resolveReplyGuardPolicy(policy) {
    const merged = { ...DEFAULT_LLM_REPLY_GUARD_POLICY, ...(policy ?? {}) };
    const count = (value, fallback) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
    const d = DEFAULT_LLM_REPLY_GUARD_POLICY;
    return {
        emptyRetries: count(merged.emptyRetries, d.emptyRetries),
        holdReasoning: merged.holdReasoning === true,
        holdReasoningMaxMs: count(merged.holdReasoningMaxMs, d.holdReasoningMaxMs),
        holdReasoningMaxEvents: count(merged.holdReasoningMaxEvents, d.holdReasoningMaxEvents),
        holdReasoningMaxChars: count(merged.holdReasoningMaxChars, d.holdReasoningMaxChars),
        loopGuard: merged.loopGuard !== false,
        loopRetries: count(merged.loopRetries, d.loopRetries),
    };
}
function retryDelayMs(retryAfterMs, retryAttempt, policy, random) {
    if (retryAfterMs !== undefined)
        // Local patch: never wait less than the fixed cadence. A gateway that
        // answers 'Retry-After: 0' would otherwise turn the retry loop into a
        // busy spin (measured: 291k attempts in 27h at 0-1ms intervals).
        return Math.max(policy.baseDelayMs, Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs)));
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
function retryTimeout() {
    const error = new Error('LLM request timed out');
    error.name = 'TimeoutError';
    return error;
}
function createRetryBudget(callerSignal, deadlineAt) {
    const controller = new AbortController();
    let expired = false;
    const expire = () => {
        expired = true;
        controller.abort(retryTimeout());
    };
    let timer;
    const arm = (at) => {
        if (timer !== undefined)
            clearTimeout(timer);
        timer = undefined;
        if (expired || at === undefined)
            return;
        const delay = Math.max(0, at - Date.now());
        if (delay === 0)
            return expire();
        timer = setTimeout(expire, delay);
        timer.unref?.();
    };
    arm(deadlineAt);
    return {
        // Clearing the deadline must never detach subsequent user cancellation.
        signal: AbortSignal.any([callerSignal, controller.signal]),
        expired: () => expired,
        arm,
        stop: () => arm(undefined),
    };
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