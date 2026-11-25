import { Buffer } from 'node:buffer';
import { streamSimple, } from '@earendil-works/pi-ai';
import { summarizeProviderError, trustedProviderRequestId, } from '@mavis/shared/logging/provider-error-summary';
const MAX_LOGGED_MESSAGES = 200;
const MAX_LOGGED_TOOLS = 200;
/**
 * Innermost provider-attempt wrapper of a local Turn.
 *
 * 1. Every provider request that fails before any content is logged once with
 *    a controlled summary of the provider error (`summarizeProviderError`:
 *    status, request id, classifier category, envelope codes, transport
 *    failures, JSON shape) and a shape-only summary of the request that was
 *    actually sent: per-message role and block types, tool names, tool_choice
 *    and thinking. Neither the message text nor the error text is logged,
 *    since a gateway may echo the request in its error.
 *
 * The failure is reported to the caller exactly as the provider gave it; the
 * generic retries decide what to resend. The stream is handed back as soon as
 * the provider call returns and its events pass through as they arrive,
 * `start` included, so the caller's first-event and idle watchdogs time the
 * provider exactly as without this wrapper.
 */
export function withProviderRequestDiagnostics(inner, options) {
    const base = inner ?? streamSimple;
    return (async (model, context, streamOptions) => {
        const observed = observeAttempt(streamOptions);
        const attempt = {
            payload: observed.payload,
            requestId: observed.requestId,
        };
        const report = (failure) => logFailure(options, model, { payload: observed.payload(), failure });
        let source;
        try {
            source = await base(model, context, observed.options);
        }
        catch (error) {
            const failure = thrownFailure(error, streamOptions, observed.requestId());
            if (failure)
                report(failure);
            throw error;
        }
        return new PassThroughAttempt(source, attempt, report, streamOptions).stream();
    });
}
/**
 * The caller's stream over the provider attempt.
 *
 * One pump is the only reader of the provider events. It starts when the
 * caller first reads an event or asks for `result()`, whichever comes first,
 * and queues every event for the caller's reader. So a `result()` asked before
 * anything reads the events (the model-access attempt cleanup, the BYOK key
 * pool) settles without taking events away from the agent loop that reads them
 * later. `result()` follows the attempt whose events the caller received.
 */
class PassThroughAttempt {
    source;
    attempt;
    onEarlyFailure;
    streamOptions;
    iterator;
    content = false;
    finished = false;
    stopped = false;
    pumping;
    reader;
    queue = [];
    wake;
    resolveSettled;
    settled = new Promise((resolve) => {
        this.resolveSettled = resolve;
    });
    constructor(source, attempt, onEarlyFailure, streamOptions) {
        this.source = source;
        this.attempt = attempt;
        this.onEarlyFailure = onEarlyFailure;
        this.streamOptions = streamOptions;
        this.iterator = source[Symbol.asyncIterator]();
    }
    stream() {
        const wrapped = Object.create(this.source);
        Object.defineProperty(wrapped, Symbol.asyncIterator, {
            value: () => {
                this.reader ??= this.events();
                return this.reader;
            },
        });
        Object.defineProperty(wrapped, 'result', { value: () => this.result() });
        return wrapped;
    }
    async result() {
        // A caller that asks for the result without reading the events still gets one;
        // the events stay queued for a reader that comes later.
        this.pump();
        const settled = await this.settled;
        if ('error' in settled)
            throw settled.error;
        return settled.source.result();
    }
    /** The caller's reader: the queued events, in order, then the end or the failure. */
    async *events() {
        this.pump();
        let ended = false;
        try {
            for (;;) {
                const next = await this.take();
                if ('event' in next) {
                    yield next.event;
                    continue;
                }
                ended = true;
                if ('error' in next)
                    throw next.error;
                return;
            }
        }
        finally {
            // The caller stopped reading early (a watchdog timeout, an abort): stop the provider too.
            if (!ended)
                await this.stop();
        }
    }
    pump() {
        this.pumping ??= this.run();
    }
    async run() {
        try {
            for (;;) {
                const event = await this.nextEvent();
                if (this.stopped)
                    return await this.release();
                if (!event)
                    return this.push({ end: true });
                this.push({ event });
            }
        }
        catch (error) {
            this.finish({ error });
            this.push({ error });
        }
    }
    async take() {
        for (;;) {
            const next = this.queue.shift();
            if (next)
                return next;
            await new Promise((resolve) => {
                this.wake = resolve;
            });
        }
    }
    push(next) {
        this.queue.push(next);
        const wake = this.wake;
        this.wake = undefined;
        wake?.();
    }
    /** The reader left before the end: stop the provider and settle `result()` on the current attempt. */
    async stop() {
        this.stopped = true;
        this.queue.length = 0;
        this.resolveSettled({ source: this.source });
        await this.release();
    }
    async release() {
        if (!this.finished)
            await releaseIterator(this.iterator);
    }
    /** The next event the caller sees, or undefined at the end of the stream. */
    async nextEvent() {
        const next = await this.read();
        if (next.done) {
            this.finish({ source: this.source });
            return undefined;
        }
        const event = next.value;
        if (event.type === 'start')
            return event;
        if (this.failsEarly(event))
            this.onEarlyFailure(failureOf(event, this.attempt));
        if (!this.content)
            this.resolveSettled({ source: this.source });
        this.content = true;
        return event;
    }
    async read() {
        try {
            return await this.iterator.next();
        }
        catch (error) {
            const failure = this.content
                ? undefined
                : thrownFailure(error, this.streamOptions, this.attempt.requestId());
            if (failure)
                this.onEarlyFailure(failure);
            throw error;
        }
    }
    failsEarly(event) {
        return !this.content && event.type === 'error' && event.reason === 'error';
    }
    finish(settled) {
        this.finished = true;
        this.resolveSettled(settled);
    }
}
function failureOf(event, attempt) {
    const message = event.type === 'error' ? event.error.errorMessage : undefined;
    return { ...(message ? { errorMessage: message } : {}), requestId: attempt.requestId() };
}
/** Ask a provider stream to stop without waiting on one that may never settle. */
async function releaseIterator(iterator) {
    // Racing an already settled value handles the stop's outcome without waiting for it.
    await Promise.race([iterator.return?.(), undefined]);
}
/**
 * Wraps the caller's `onPayload`, `onResponse` and `onProviderError` to
 * remember the body that was actually sent and the request id. A rejected
 * HTTP call never reaches `onResponse`: the provider catches the SDK error and
 * reports it as an error event, so its id is read from that error object.
 */
function observeAttempt(streamOptions) {
    let payload;
    let requestId;
    const callerOnPayload = streamOptions?.onPayload;
    const callerOnResponse = streamOptions?.onResponse;
    const callerOnProviderError = streamOptions?.onProviderError;
    return {
        options: {
            ...(streamOptions ?? {}),
            onPayload: async (raw, payloadModel) => {
                const next = await callerOnPayload?.(raw, payloadModel);
                payload = next === undefined ? raw : next;
                return next;
            },
            onResponse: async (response, responseModel) => {
                requestId = trustedProviderRequestId(headerRequestId(response.headers));
                await callerOnResponse?.(response, responseModel);
            },
            onProviderError: (error, errorModel) => {
                try {
                    requestId = trustedProviderRequestId(errorRequestId(error)) ?? requestId;
                }
                finally {
                    callerOnProviderError?.(error, errorModel);
                }
            },
        },
        payload: () => payload,
        requestId: () => requestId,
    };
}
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id'];
function headerRequestId(headers) {
    if (!isRecord(headers))
        return undefined;
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (REQUEST_ID_HEADERS.some((header) => header === lower) && typeof value === 'string')
            return value;
    }
    return undefined;
}
/** The request id an SDK error object carries in a fixed field or in its response headers. */
function errorRequestId(error) {
    if (!isRecord(error))
        return undefined;
    return error.requestID ?? error.request_id ?? error.requestId ?? headerRequestId(error.headers);
}
/** A thrown error counts as a provider failure unless the caller aborted the request. */
function thrownFailure(error, streamOptions, responseRequestId) {
    if (streamOptions?.signal?.aborted)
        return undefined;
    return {
        errorMessage: errorText(error),
        requestId: trustedProviderRequestId(errorRequestId(error)) ?? responseRequestId,
    };
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function logFailure(options, model, { payload, failure }) {
    try {
        const { status, requestId, ...error } = summarizeProviderError(failure.errorMessage ?? '', {
            requestId: failure.requestId,
        });
        options.logger?.warn?.({
            session_id: options.sessionId,
            turn_id: options.turnId,
            provider: model.provider,
            model: model.id,
            api: model.api,
            ...(status ? { response_status: status } : {}),
            ...(requestId ? { downstream_request_id: requestId } : {}),
            error,
            request: summarizeProviderPayload(payload),
        }, 'llm_request_failed');
    }
    catch {
        // Diagnostics must never change provider-call behavior.
    }
}
/**
 * Shape-only summary of a provider request body; never includes message text.
 * @internal Exported only for focused tests.
 */
export function summarizeProviderPayload(payload) {
    if (!isRecord(payload))
        return { captured: false };
    const messages = payloadMessages(payload);
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    const byteLength = payloadByteLength(payload);
    return {
        captured: true,
        ...(byteLength === undefined ? {} : { byteLength }),
        messageCount: messages.length,
        messages: messages.slice(-MAX_LOGGED_MESSAGES).map(describeMessage),
        tools: tools.slice(0, MAX_LOGGED_TOOLS).map(toolName),
        ...requestControls(payload),
    };
}
/** Messages-protocol bodies carry `messages`; Responses-protocol bodies carry `input`. */
function payloadMessages(payload) {
    if (Array.isArray(payload.messages))
        return payload.messages;
    return Array.isArray(payload.input) ? payload.input : [];
}
function payloadByteLength(payload) {
    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    }
    catch {
        return undefined;
    }
}
/** tool_choice, thinking and output effort, each only when the body sets it. */
function requestControls(payload) {
    return {
        ...(payload.tool_choice === undefined ? {} : { toolChoice: payload.tool_choice }),
        ...(payload.thinking === undefined ? {} : { thinking: payload.thinking }),
        ...(isRecord(payload.output_config) && payload.output_config.effort !== undefined
            ? { outputConfig: { effort: payload.output_config.effort } }
            : {}),
    };
}
function describeMessage(message) {
    if (!isRecord(message))
        return typeof message;
    const role = messageRole(message);
    const content = message.content;
    if (typeof content === 'string')
        return `${role}:string${content.length === 0 ? '(empty)' : ''}`;
    if (!Array.isArray(content))
        return role;
    return `${role}:${content.map(describeBlock).join(',')}`;
}
/** Messages-protocol messages have a `role`; Responses-protocol input items have a `type`. */
function messageRole(message) {
    if (typeof message.role === 'string')
        return message.role;
    return typeof message.type === 'string' ? message.type : '?';
}
function describeBlock(block) {
    if (!isRecord(block))
        return typeof block;
    const type = typeof block.type === 'string' ? block.type : '?';
    if (type === 'text' && block.text === '')
        return 'text(empty)';
    if (type === 'thinking' && block.thinking === '')
        return 'thinking(empty)';
    if (type === 'tool_use' && typeof block.name === 'string')
        return `tool_use(${block.name})`;
    return type;
}
function toolName(tool) {
    if (!isRecord(tool))
        return '?';
    if (typeof tool.name === 'string')
        return tool.name;
    const fn = tool.function;
    return isRecord(fn) && typeof fn.name === 'string' ? fn.name : '?';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=provider-request-diagnostics.js.map