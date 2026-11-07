import { createAssistantMessageEventStream, streamSimple, } from '@earendil-works/pi-ai';
import { LLM_FIRST_EVENT_TIMEOUT_MS, LLM_FIRST_EVENT_TIMEOUT_ENV, LLM_STREAM_IDLE_TIMEOUT_ENV, LLM_STREAM_IDLE_TIMEOUT_MS, } from './defaults.js';
/** Marker included in every synthesized timeout message; matches the shared timeout classifier. */
export const LLM_STREAM_TIMEOUT_MESSAGE_PREFIX = 'LLM request timed out';
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
export function withLLMStreamTimeouts(inner, timeouts) {
    const base = inner ?? streamSimple;
    if (timeouts.firstEventTimeoutMs <= 0 && timeouts.idleTimeoutMs <= 0)
        return base;
    return (async (model, context, options) => {
        const watchdog = new StreamWatchdog(model, options?.signal, timeouts);
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
    controller = new AbortController();
    timedOut;
    resolveTimedOut;
    timer;
    settled = false;
    lastPartial;
    timeoutMessage;
    constructor(model, callerSignal, timeouts) {
        this.model = model;
        this.callerSignal = callerSignal;
        this.timeouts = timeouts;
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
                    this.arm(this.timeouts.idleTimeoutMs, 'idle');
                const next = await this.untilTimeout(iterator.next());
                if (next === TIMED_OUT) {
                    releaseIterator(iterator);
                    completed = true;
                    yield this.timeoutEvent();
                    return;
                }
                this.clearTimer();
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
        const message = timeoutMessage(phase, ms);
        this.timeoutMessage = {
            ...snapshot(this.lastPartial, this.model),
            stopReason: 'error',
            errorMessage: message,
        };
        this.settle();
        this.resolveTimedOut(TIMED_OUT);
        this.controller.abort(new LLMStreamTimeoutError(message));
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
export class LLMStreamTimeoutError extends Error {
    name = 'TimeoutError';
}
function timeoutMessage(phase, ms) {
    return phase === 'first'
        ? `${LLM_STREAM_TIMEOUT_MESSAGE_PREFIX}: no response from the provider within ${ms}ms. ` +
            `Raise it with ${LLM_FIRST_EVENT_TIMEOUT_ENV} (milliseconds, 0 disables) or the host's per-model firstEventTimeoutMs.`
        : `${LLM_STREAM_TIMEOUT_MESSAGE_PREFIX}: the provider stream was idle for ${ms}ms. ` +
            `Raise it with ${LLM_STREAM_IDLE_TIMEOUT_ENV} (milliseconds, 0 disables) or the host's per-model streamIdleTimeoutMs.`;
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