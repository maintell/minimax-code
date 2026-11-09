import { randomUUID } from 'node:crypto';
import { observeModelAccessWork } from '../core/settlement.js';
import { MODEL_ACCESS_HOST_MAX_LINE_BYTES, MODEL_ACCESS_HOST_MAX_PENDING_REQUESTS, encodeHostMessage, HostLineDecoder, ModelAccessHostProtocolError, } from './protocol.js';
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/**
 * How long a streamed fetch waits for the vendor's response head. Only the head is bounded here:
 * once it came, the body runs as long as the caller lets it (its signal, and agent-core's
 * first-event and idle watchdogs), so a model that talks for minutes is never cut. Matches
 * agent-core's first-event budget (LLM_FIRST_EVENT_TIMEOUT_MS) so the host never gives up first.
 */
const DEFAULT_STREAM_HEAD_TIMEOUT_MS = 300_000;
export class ModelAccessHostPeerImpl {
    epoch;
    child;
    input;
    decoder;
    pending = new Map();
    writes = [];
    maxPendingRequests;
    requestTimeoutMs;
    streamHeadTimeoutMs;
    writing = false;
    hello;
    ready;
    settled = false;
    failure;
    crashed;
    onFailure;
    seenEvents = new Set();
    constructor(options) {
        this.onFailure = options.onFailure;
        this.child = options.child;
        this.input =
            options.child.stdin ??
                (() => {
                    throw new Error('host_stdin_unavailable');
                })();
        this.epoch = options.epoch;
        this.decoder = new HostLineDecoder(options.maxLineBytes ?? MODEL_ACCESS_HOST_MAX_LINE_BYTES);
        this.maxPendingRequests = options.maxPendingRequests ?? MODEL_ACCESS_HOST_MAX_PENDING_REQUESTS;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.streamHeadTimeoutMs = options.streamHeadTimeoutMs ?? DEFAULT_STREAM_HEAD_TIMEOUT_MS;
        this.child.stdout?.on('data', (chunk) => this.onData(chunk));
        this.child.stdout?.on('end', () => this.onEnd());
        this.child.on('error', (error) => this.fail(error instanceof Error ? error : new Error('host_process_error')));
        this.child.on('exit', () => this.onEnd());
    }
    get closed() {
        return this.settled;
    }
    get crashedSlot() {
        return this.crashed;
    }
    waitForHello(timeoutMs = this.requestTimeoutMs) {
        this.hello ??= this.waitForEvent('hello', timeoutMs);
        return this.hello;
    }
    waitForReady(timeoutMs = this.requestTimeoutMs) {
        this.ready ??= this.waitForEvent('ready', timeoutMs);
        return this.ready;
    }
    request(method, params, options = {}) {
        if (this.settled)
            return Promise.reject(this.failure ?? new Error('host_closed'));
        if (options.signal?.aborted)
            return Promise.reject(new Error('host_request_cancelled'));
        if (this.pending.size >= this.maxPendingRequests)
            return Promise.reject(new Error('host_request_busy'));
        const id = randomUUID();
        const message = {
            type: 'request',
            version: 1,
            epoch: this.epoch,
            id,
            method,
            params,
            ...(options.slot === undefined ? {} : { slot: options.slot }),
        };
        const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            return Promise.reject(new Error('host_request_timeout_invalid'));
        return new Promise((resolve, reject) => {
            let timer;
            const onAbort = () => {
                observeModelAccessWork(this.sendCancel(id));
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                if (options.settleOnAbort)
                    return;
                this.pending.delete(id);
                reject(new Error('host_request_cancelled'));
            };
            timer = setTimeout(() => {
                observeModelAccessWork(this.sendCancel(id));
                if (options.signal)
                    options.signal.removeEventListener('abort', onAbort);
                if (options.settleOnAbort)
                    return;
                this.pending.delete(id);
                reject(new Error('host_request_timeout'));
            }, timeoutMs);
            timer.unref?.();
            const pending = {
                resolve: (value) => resolve(value),
                reject,
                timer,
                ...(options.signal ? { signal: options.signal, onAbort } : {}),
            };
            this.pending.set(id, pending);
            options.signal?.addEventListener('abort', onAbort, { once: true });
            if (options.signal?.aborted)
                onAbort();
            else
                observeModelAccessWork(this.writeOrFail(message));
        });
    }
    requestStream(method, params, options = {}) {
        if (this.settled)
            return Promise.reject(this.failure ?? new Error('host_closed'));
        if (this.pending.size >= this.maxPendingRequests)
            return Promise.reject(new Error('host_request_busy'));
        const id = randomUUID();
        // Bounds the wait for the head only; the timer is cleared when the head arrives.
        const timeoutMs = options.timeoutMs ?? this.streamHeadTimeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
            return Promise.reject(new Error('host_request_timeout_invalid'));
        let headResolve;
        let headReject;
        let bodyController;
        let headSeen = false;
        let bodyEnded = false;
        let streamEnded = false;
        let requestOpen = true;
        let pullWake;
        let timer;
        const chunks = [];
        const head = new Promise((resolve, reject) => {
            headResolve = resolve;
            headReject = reject;
        });
        const failStream = (error, cancel = true) => {
            if (!requestOpen && bodyEnded)
                return;
            requestOpen = false;
            streamEnded = true;
            bodyEnded = true;
            pullWake = undefined;
            this.pending.delete(id);
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            if (!headSeen)
                headReject(error);
            try {
                bodyController.error(error);
            }
            catch {
                /* The consumer may have already closed the body. */
            }
            if (cancel)
                observeModelAccessWork(this.sendCancel(id));
        };
        const body = new ReadableStream({
            start: (controller) => {
                bodyController = controller;
            },
            pull: () => {
                const chunk = chunks.shift();
                if (chunk) {
                    bodyController.enqueue(chunk);
                    observeModelAccessWork(this.creditOrFail(id, chunk.byteLength + 2048, failStream));
                    return;
                }
                if (streamEnded) {
                    bodyEnded = true;
                    bodyController.close();
                    return;
                }
                return new Promise((resolve) => {
                    pullWake = () => {
                        pullWake = undefined;
                        const next = chunks.shift();
                        if (next) {
                            bodyController.enqueue(next);
                            observeModelAccessWork(this.creditOrFail(id, next.byteLength + 2048, failStream));
                        }
                        else if (streamEnded) {
                            bodyEnded = true;
                            bodyController.close();
                        }
                        resolve();
                    };
                });
            },
            cancel: () => {
                if (bodyEnded)
                    return;
                bodyEnded = true;
                streamEnded = true;
                requestOpen = false;
                pullWake = undefined;
                this.pending.delete(id);
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                observeModelAccessWork(this.sendCancel(id));
            },
        }, { highWaterMark: 0 });
        const onStream = createStreamReceiver({
            state: () => ({ headSeen, ended: streamEnded || bodyEnded }),
            head: (message) => {
                headSeen = true;
                // From here the caller owns the stream's length (signal, cancel, its own watchdogs).
                clearTimeout(timer);
                headResolve(new Response(body, {
                    status: message.status,
                    headers: message.headers,
                }));
            },
            chunk: (bytes) => {
                chunks.push(bytes);
                pullWake?.();
            },
            end: () => {
                streamEnded = true;
                pullWake?.();
            },
            fail: failStream,
        });
        const onAbort = () => {
            if (!requestOpen)
                return;
            requestOpen = false;
            this.pending.delete(id);
            observeModelAccessWork(this.sendCancel(id));
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            const error = new Error('host_request_cancelled');
            if (!headSeen)
                headReject(error);
            streamEnded = true;
            bodyEnded = true;
            pullWake = undefined;
            try {
                bodyController.error(error);
            }
            catch {
                /* The consumer may have already closed the body. */
            }
        };
        timer = setTimeout(() => {
            requestOpen = false;
            streamEnded = true;
            bodyEnded = true;
            this.pending.delete(id);
            observeModelAccessWork(this.sendCancel(id));
            options.signal?.removeEventListener('abort', onAbort);
            const error = new Error('host_request_timeout');
            if (!headSeen)
                headReject(error);
            try {
                bodyController.error(error);
            }
            catch {
                /* The consumer may have already closed the body. */
            }
        }, timeoutMs);
        timer.unref?.();
        const pending = {
            resolve: () => {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                requestOpen = false;
                if (!headSeen) {
                    const error = new Error('host_stream_head_missing');
                    headReject(error);
                    bodyEnded = true;
                    streamEnded = true;
                    try {
                        bodyController.error(error);
                    }
                    catch {
                        /* The consumer may have already closed the body. */
                    }
                }
            },
            reject: (error) => {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', onAbort);
                requestOpen = false;
                streamEnded = true;
                bodyEnded = true;
                if (!headSeen)
                    headReject(error);
                try {
                    bodyController.error(error);
                }
                catch {
                    /* The consumer may have already closed the body. */
                }
            },
            timer,
            ...(options.signal ? { signal: options.signal, onAbort } : {}),
            onStream,
        };
        this.pending.set(id, pending);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted)
            onAbort();
        else {
            const message = {
                type: 'request',
                version: 1,
                epoch: this.epoch,
                id,
                method,
                params,
                ...(options.slot === undefined ? {} : { slot: options.slot }),
            };
            observeModelAccessWork(this.writeOrFail(message));
        }
        return head;
    }
    credit(id, n) {
        if (!Number.isSafeInteger(n) || n <= 0)
            return Promise.reject(new Error('host_credit_invalid'));
        return this.write({ type: 'credit', version: 1, epoch: this.epoch, id, n });
    }
    async creditOrFail(id, amount, fail) {
        try {
            await this.credit(id, amount);
        }
        catch (error) {
            fail(error instanceof Error ? error : new Error('host_credit_failed'));
        }
    }
    async writeOrFail(message) {
        try {
            await this.write(message);
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error('host_write_failed'));
        }
    }
    subscribeFlow(flowRef, listener) {
        if (this.settled)
            throw this.failure ?? new Error('host_closed');
        if (!flowRef.startsWith(`${this.epoch}:`) ||
            flowRef.length > 256 ||
            this.flowListeners.has(flowRef))
            throw new ModelAccessHostProtocolError('protocol_flow');
        if (this.flowListeners.size >= MODEL_ACCESS_HOST_MAX_PENDING_REQUESTS)
            throw new Error('host_request_busy');
        const listeners = new Set();
        this.flowListeners.set(flowRef, listeners);
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0)
                this.flowListeners.delete(flowRef);
        };
    }
    close(error = new Error('host_closed')) {
        this.fail(error);
    }
    waitForEvent(event, timeoutMs) {
        if (this.settled)
            return Promise.reject(this.failure ?? new Error('host_closed'));
        if (this.seenEvents.has(event))
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            let waiter;
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`host_${event}_timeout`));
            }, timeoutMs);
            timer.unref?.();
            const cleanup = () => {
                clearTimeout(timer);
                this.eventWaiters.get(event)?.delete(waiter);
            };
            waiter = {
                resolve: () => {
                    cleanup();
                    resolve();
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
                timer,
            };
            let waiters = this.eventWaiters.get(event);
            if (!waiters) {
                waiters = new Set();
                this.eventWaiters.set(event, waiters);
            }
            waiters.add(waiter);
        });
    }
    eventWaiters = new Map();
    flowListeners = new Map();
    onData(chunk) {
        if (this.settled)
            return;
        try {
            for (const message of this.decoder.push(chunk))
                this.onMessage(message);
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new ModelAccessHostProtocolError('protocol_read'));
        }
    }
    onMessage(message) {
        if (message.epoch !== this.epoch) {
            this.fail(new Error('host_epoch_mismatch'));
            return;
        }
        if (message.type === 'event') {
            this.onEvent(message);
            return;
        }
        if (message.type === 'flow') {
            this.onFlow(message);
            return;
        }
        if (message.type === 'stream') {
            this.pending.get(message.id)?.onStream?.(message);
            return;
        }
        if (message.type !== 'response')
            return;
        this.onResponse(message);
    }
    onEvent(message) {
        this.seenEvents.add(message.event);
        if (message.event === 'fatal') {
            if (!this.settled && message.slot !== undefined)
                this.crashed = message.slot;
            this.fail(new Error(message.error?.code ?? 'host_fatal'));
            return;
        }
        const waiters = this.eventWaiters.get(message.event);
        this.eventWaiters.delete(message.event);
        if (waiters)
            for (const waiter of waiters)
                waiter.resolve();
    }
    onFlow(message) {
        for (const listener of this.flowListeners.get(message.flowRef) ?? []) {
            try {
                listener(message);
            }
            catch {
                /* Stale parent flows cannot terminate unrelated host calls. */
            }
        }
    }
    onResponse(message) {
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        if (message.type === 'response' && pending.onStream && message.error === undefined) {
            pending.resolve(message.result);
            this.pending.delete(message.id);
            return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.onAbort);
        if (message.error)
            pending.reject(errorFromHost(message.error));
        else
            pending.resolve(message.result);
    }
    onEnd() {
        if (this.settled)
            return;
        try {
            this.decoder.finish();
            this.fail(new Error('host_exited'));
        }
        catch (error) {
            this.fail(error instanceof Error ? error : new Error('host_protocol_truncated'));
        }
    }
    fail(error) {
        if (this.settled)
            return;
        markHostFailure(error);
        this.settled = true;
        this.failure = error;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.signal?.removeEventListener('abort', pending.onAbort);
            pending.reject(error);
        }
        this.pending.clear();
        for (const write of this.writes.splice(0))
            write.reject(error);
        for (const waiters of this.eventWaiters.values()) {
            for (const waiter of waiters)
                waiter.reject(error);
        }
        this.eventWaiters.clear();
        this.flowListeners.clear();
        try {
            this.onFailure?.();
        }
        catch {
            /* Notification failure must not interrupt pending request settlement. */
        }
    }
    async sendCancel(id) {
        if (this.settled)
            return;
        try {
            await this.write({ type: 'cancel', version: 1, epoch: this.epoch, id });
        }
        catch {
            /* The original request already settled; process failure settles the rest. */
        }
    }
    write(message) {
        if (this.settled)
            return Promise.reject(this.failure ?? new Error('host_closed'));
        const line = encodeHostMessage(message, this.decoder.limit);
        return new Promise((resolve, reject) => {
            this.writes.push({ line, resolve, reject });
            this.pumpWrites();
        });
    }
    pumpWrites() {
        if (this.writing || this.settled)
            return;
        const next = this.writes.shift();
        if (!next)
            return;
        this.writing = true;
        let accepted = false;
        try {
            accepted = this.input.write(next.line, 'utf8');
        }
        catch (error) {
            this.writing = false;
            next.reject(error instanceof Error ? error : new Error('host_write_failed'));
            this.fail(error instanceof Error ? error : new Error('host_write_failed'));
            return;
        }
        next.resolve();
        if (accepted) {
            this.writing = false;
            this.pumpWrites();
            return;
        }
        const resume = () => {
            this.input.removeListener('drain', resume);
            this.input.removeListener('error', failed);
            this.writing = false;
            this.pumpWrites();
        };
        const failed = (error) => {
            this.input.removeListener('drain', resume);
            this.input.removeListener('error', failed);
            this.writing = false;
            this.fail(error);
        };
        this.input.once('drain', resume);
        this.input.once('error', failed);
    }
}
function createStreamReceiver(receiver) {
    return (message) => {
        const state = receiver.state();
        const invalid = invalidStreamEvent(message, state);
        if (invalid) {
            receiver.fail(new Error(invalid));
            return;
        }
        switch (message.event) {
            case 'head':
                receiver.head(message);
                return;
            case 'chunk':
                receiveChunk(receiver, message.data);
                return;
            case 'end':
                receiver.end();
                return;
            default:
                receiver.fail(errorFromHost(message.error ?? { code: 'host_stream_failed' }));
        }
    };
}
function invalidStreamEvent(message, state) {
    const cannotReceiveBody = !state.headSeen || state.ended;
    switch (message.event) {
        case 'head':
            return invalidStreamHead(message, state) ? 'host_stream_head_invalid' : undefined;
        case 'chunk':
            return cannotReceiveBody || typeof message.data !== 'string'
                ? 'host_stream_chunk_invalid'
                : undefined;
        case 'end':
            return cannotReceiveBody ? 'host_stream_end_invalid' : undefined;
        default:
            return state.ended ? 'host_stream_error_invalid' : undefined;
    }
}
function invalidStreamHead(message, state) {
    return (state.headSeen || state.ended || message.status === undefined || message.headers === undefined);
}
function receiveChunk(receiver, data) {
    try {
        if (typeof data !== 'string')
            throw new Error('host_stream_chunk_invalid');
        const bytes = Buffer.from(data, 'base64');
        if (bytes.length > 64 * 1024)
            throw new Error('host_stream_chunk_too_large');
        receiver.chunk(bytes);
    }
    catch (error) {
        receiver.fail(error instanceof Error ? error : new Error('host_stream_chunk_invalid'));
    }
}
function errorFromHost(error) {
    const result = new Error(error.code);
    Object.defineProperty(result, 'code', { value: error.code, enumerable: true });
    if (!error.ref || error.code.startsWith('request_body_'))
        markHostFailure(result);
    if (error.ref)
        Object.defineProperty(result, 'errorRef', { value: error.ref, enumerable: false });
    return result;
}
function markHostFailure(error) {
    try {
        if (!('code' in error))
            Object.defineProperty(error, 'code', { value: 'host_unavailable' });
        Object.defineProperty(error, 'hostFailure', {
            configurable: true,
            enumerable: false,
            value: true,
        });
    }
    catch {
        /* A frozen error still fails the pending host operation safely. */
    }
}
//# sourceMappingURL=peer.js.map