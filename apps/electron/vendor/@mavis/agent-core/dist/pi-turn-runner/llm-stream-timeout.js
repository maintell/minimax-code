import { createAssistantMessageEventStream, streamSimple, } from '@earendil-works/pi-ai';
import { LLM_FIRST_EVENT_TIMEOUT_MS, LLM_FIRST_EVENT_TIMEOUT_ENV, LLM_STREAM_IDLE_TIMEOUT_ENV, LLM_STREAM_IDLE_TIMEOUT_MS, } from './defaults.js';
import { withLLMStreamFailure } from './llm-stream-failure.js';
/** Marker included in every synthesized timeout message; matches the shared timeout classifier. */
export const LLM_STREAM_TIMEOUT_MESSAGE_PREFIX = 'LLM request timed out';
/**
 * Marker of a stream dropped after a system resume. It names the network, so
 * the shared classifier treats it as a retryable network failure.
 */
export const LLM_RESUME_STALL_MESSAGE_PREFIX = 'LLM network connection lost after system resume';
/** Default wait for a provider event after a system resume before the stream counts as dead. */
export const LLM_RESUME_STALL_MS = 20_000;
/**
 * Resolve effective timeouts. Precedence: explicit host config, then the
 * environment override, then the built-in default. Invalid values (negative,
 * non-integer, non-numeric) fall through to the next source.
 */
export function resolveLLMStreamTimeouts(config = {}, env = readProcessEnv()) {
    return {
        firstEventTimeoutMs: validTimeout(config.firstEventTimeoutMs) ??
            parseTimeout(env[LLM_FIRST_EVENT_TIMEOUT_ENV]) ??
            LLM_FIRST_EVENT_TIMEOUT_MS,
        idleTimeoutMs: validTimeout(config.streamIdleTimeoutMs) ??
            parseTimeout(env[LLM_STREAM_IDLE_TIMEOUT_ENV]) ??
            LLM_STREAM_IDLE_TIMEOUT_MS,
    };
}
/**
 * Wrap a StreamFn so each invocation (each physical request, including every
 * retry attempt made by `withLLMRetry`) is guarded by the watchdog.
 *
 * The returned stream is a pull-through proxy: events are read from the inner
 * stream only when the consumer asks for them, `result()` delegates to the
 * inner stream, and a rejected provider call propagates unchanged. The idle
 * bound therefore measures time spent waiting on the provider, not on the
 * consumer.
 *
 * On timeout the inner request is aborted through a linked signal and the
 * returned stream ends with a terminal `error` event whose stop reason is
 * `error` (not `aborted`), so the retry layer treats it as a retryable
 * transport timeout rather than a user cancellation. A caller abort is passed
 * through unchanged and never reported as a timeout.
 */
export function withLLMStreamTimeouts(inner, timeouts, resume) {
    const base = inner ?? streamSimple;
    if (timeouts.firstEventTimeoutMs <= 0 && timeouts.idleTimeoutMs <= 0 && !resume)
        return base;
    return (async (model, context, options) => {
        const watchdog = new StreamWatchdog(model, options?.signal, timeouts, resume);
        let opened;
        try {
            opened = await watchdog.untilTimeout(Promise.resolve(base(model, context, { ...(options ?? {}), signal: watchdog.signal })));
        }
        catch (error) {
            watchdog.settle();
            throw error;
        }
        return opened === TIMED_OUT ? watchdog.timedOutStream() : watchdog.guard(opened);
    });
}
const TIMED_OUT = Symbol('llm-stream-timed-out');
class StreamWatchdog {
    model;
    callerSignal;
    timeouts;
    resume;
    controller = new AbortController();
    timedOut;
    resolveTimedOut;
    timer;
    settled = false;
    lastPartial;
    timeoutMessage;
    unsubscribeResume;
    /** A resume hint arrived and no provider event has proved the connection alive since. */
    resumePending = false;
    constructor(model, callerSignal, timeouts, resume) {
        this.model = model;
        this.callerSignal = callerSignal;
        this.timeouts = timeouts;
        this.resume = resume;
        this.timedOut = new Promise((resolve) => {
            this.resolveTimedOut = resolve;
        });
        if (callerSignal?.aborted) {
            this.controller.abort(callerSignal.reason);
            this.settled = true;
            return;
        }
        callerSignal?.addEventListener('abort', this.onCallerAbort, { once: true });
        this.arm(timeouts.firstEventTimeoutMs, 'first');
        this.unsubscribeResume = resume?.onResume(this.onResume);
    }
    get signal() {
        return this.controller.signal;
    }
    untilTimeout(pending) {
        return Promise.race([this.timedOut, pending]);
    }
    settle() {
        this.settled = true;
        this.clearTimer();
        this.callerSignal?.removeEventListener('abort', this.onCallerAbort);
        this.unsubscribeResume?.();
        this.unsubscribeResume = undefined;
    }
    timedOutStream() {
        const out = createAssistantMessageEventStream();
        out.push(this.timeoutEvent());
        out.end();
        return out;
    }
    guard(stream) {
        const events = this.read(stream);
        return {
            [Symbol.asyncIterator]: () => events,
            result: async () => {
                const final = await this.untilTimeout(stream.result());
                return final === TIMED_OUT ? this.timeoutMessage : final;
            },
        };
    }
    async *read(stream) {
        const iterator = stream[Symbol.asyncIterator]();
        let receivedFirst = false;
        let completed = false;
        try {
            for (;;) {
                if (receivedFirst)
                    this.armBetweenEvents();
                const next = await this.untilTimeout(iterator.next());
                if (next === TIMED_OUT) {
                    releaseIterator(iterator);
                    completed = true;
                    yield this.timeoutEvent();
                    return;
                }
                this.clearTimer();
                this.resumePending = false;
                if (next.done) {
                    completed = true;
                    return;
                }
                receivedFirst = true;
                const event = next.value;
                const partial = partialOf(event);
                if (partial)
                    this.lastPartial = partial;
                if (event.type === 'done' || event.type === 'error')
                    this.settle();
                yield event;
            }
        }
        finally {
            this.settle();
            if (!completed)
                releaseIterator(iterator);
        }
    }
    onCallerAbort = () => {
        this.clearTimer();
        this.controller.abort(this.callerSignal?.reason);
    };
    /** Until the next provider event, every wait on the provider uses the resume bound. */
    onResume = () => {
        if (!this.resume || this.settled)
            return;
        this.resumePending = true;
        this.arm(this.resume.stallMs, 'resume');
    };
    armBetweenEvents() {
        if (this.resumePending && this.resume)
            this.arm(this.resume.stallMs, 'resume');
        else
            this.arm(this.timeouts.idleTimeoutMs, 'idle');
    }
    arm(ms, phase) {
        this.clearTimer();
        if (ms <= 0 || this.settled || this.callerSignal?.aborted)
            return;
        this.timer = setTimeout(() => this.fire(phase, ms), ms);
        // Never keep the process alive only for the watchdog.
        this.timer.unref?.();
    }
    fire(phase, ms) {
        if (this.settled || this.callerSignal?.aborted)
            return;
        if (phase === 'resume') {
            // A connection that did not survive a system sleep is a network loss, not
            // a stream-layer timeout: no failure marker, so it classifies as network.
            const message = resumeStallMessage(ms);
            this.timeoutMessage = {
                ...snapshot(this.lastPartial, this.model),
                stopReason: 'error',
                errorMessage: message,
            };
            this.settle();
            this.resolveTimedOut(TIMED_OUT);
            this.controller.abort(new Error(message));
            return;
        }
        const message = timeoutMessage(phase, ms);
        const kind = timeoutKind(phase);
        // The marker lets a host lease tell a watchdog timeout from a provider failure
        // (see llm-stream-failure.ts); the words stay as before for the shared classifier.
        this.timeoutMessage = withLLMStreamFailure(snapshot(this.lastPartial, this.model), kind, message, {
            timeoutMs: ms,
        });
        this.settle();
        this.resolveTimedOut(TIMED_OUT);
        this.controller.abort(new LLMStreamTimeoutError(message, kind));
    }
    clearTimer() {
        if (this.timer !== undefined)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    timeoutEvent() {
        return { type: 'error', reason: 'error', error: this.timeoutMessage };
    }
}
/** Ask the inner stream to stop without waiting on one that may never settle. */
function releaseIterator(iterator) {
    void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
}
/**
 * The abort reason of a timed-out attempt. `code` is the stable stream-failure
 * kind (`llm_first_event_timeout` / `llm_stream_idle_timeout`) and `llmStreamFailure` marks it
 * as decided by this layer, not by the provider.
 */
export class LLMStreamTimeoutError extends Error {
    code;
    name = 'TimeoutError';
    llmStreamFailure = true;
    errorKind = 'timeout';
    timeoutPhase;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.timeoutPhase = code === 'llm_first_event_timeout' ? 'first' : 'idle';
    }
}
function timeoutKind(phase) {
    return phase === 'first' ? 'llm_first_event_timeout' : 'llm_stream_idle_timeout';
}
function timeoutMessage(phase, ms) {
    return phase === 'first'
        ? `${LLM_STREAM_TIMEOUT_MESSAGE_PREFIX}: no response from the provider within ${ms}ms. ` +
            `Raise it with ${LLM_FIRST_EVENT_TIMEOUT_ENV} (milliseconds, 0 disables) or the host's per-model firstEventTimeoutMs.`
        : `${LLM_STREAM_TIMEOUT_MESSAGE_PREFIX}: the provider stream was idle for ${ms}ms. ` +
            `Raise it with ${LLM_STREAM_IDLE_TIMEOUT_ENV} (milliseconds, 0 disables) or the host's per-model streamIdleTimeoutMs.`;
}
function resumeStallMessage(ms) {
    return `${LLM_RESUME_STALL_MESSAGE_PREFIX}: no provider event within ${ms}ms after the system resumed.`;
}
function partialOf(event) {
    if (event.type === 'done')
        return event.message;
    if (event.type === 'error')
        return event.error;
    return event.partial;
}
/** Detach from the provider's mutable partial so a late abort cannot rewrite the reported message. */
function snapshot(partial, model) {
    return partial ? { ...partial, content: [...partial.content] } : blankAssistant(model);
}
function blankAssistant(model) {
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
function validTimeout(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function parseTimeout(raw) {
    if (raw === undefined || raw.trim() === '' || !/^\d+$/u.test(raw.trim()))
        return undefined;
    return validTimeout(Number(raw.trim()));
}
function readProcessEnv() {
    return (globalThis.process?.env ?? {});
}
//# sourceMappingURL=llm-stream-timeout.js.map