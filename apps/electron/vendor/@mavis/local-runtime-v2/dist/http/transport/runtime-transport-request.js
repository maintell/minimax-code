import { isEventStreamResponse, toHeaderMap } from './runtime-transport-response.js';
import { createRuntimeTransportWriter, } from './runtime-transport-writer.js';
function isAbortError(error) {
    return error instanceof Error && error.name === 'AbortError';
}
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message || error.name;
    return String(error);
}
function createFetchRequest(frame, url, signal) {
    const init = {
        method: frame.method,
        headers: frame.headers,
        signal,
    };
    if (frame.body !== undefined) {
        // Node's BodyInit needs an owned ArrayBuffer view at the fetch boundary.
        init.body = typeof frame.body === 'string' ? frame.body : new Uint8Array(frame.body);
        init.duplex = 'half';
    }
    return new Request(url, init);
}
async function cancelResponseBody(body) {
    try {
        await body?.cancel();
    }
    catch {
        // Cancellation is best-effort after abort or loss of the delivery channel.
    }
}
function configureResponseFlow(entry, method, response) {
    entry.deliveryOnly = method.toUpperCase() === 'GET' && isEventStreamResponse(response);
    // Only long-lived SSE responses use the v2 credit window. Ordinary
    // JSON/binary fetches preserve native buffering semantics, and legacy
    // raw clients that omit streamWindow remain wire-compatible.
    if (!isEventStreamResponse(response))
        entry.streamCredits = null;
}
async function readResponseBody(body, options) {
    const { entry, writer, isClosed } = options;
    const reader = body.getReader();
    entry.cancelBody = () => {
        entry.cancellation ??= cancelResponseBody(reader);
    };
    for (;;) {
        if (!(await writer.waitForReadCapacity())) {
            return false;
        }
        const { done, value } = await reader.read();
        if (entry.clientAborted || isClosed()) {
            return false;
        }
        if (done)
            break;
        if (value)
            writer.enqueueChunk(value);
    }
    return true;
}
export async function serveRuntimeTransportRequest(options) {
    const { frame, url, entry, handleRequest, post, isClosed, isActive, onFinalize, warn, coalesceIntervalMs, maxFrameBytes, } = options;
    const { id, method, streamWindow } = frame;
    /** seq 0 is response-start; chunk/done/error frames continue from it. */
    let seq = 0;
    const writer = createRuntimeTransportWriter({
        state: entry,
        isClosed,
        postChunk: (payload) => {
            seq += 1;
            postFrame({ type: 'stream-chunk', id, seq, payload });
        },
        streamWindow,
        coalesceIntervalMs,
        maxFrameBytes,
    });
    const finalize = () => {
        writer.dispose();
        onFinalize();
        entry.releaseStream?.();
        entry.releaseStream = undefined;
    };
    /**
     * Posts one response frame for THIS request. A postMessage failure here
     * means the client can no longer receive completion frames — leaving the
     * request "live" would strand the renderer's fetch forever, so the
     * request is aborted and dropped instead of warning-and-continuing.
     */
    const postFrame = (outgoing) => {
        if (isClosed() || entry.clientAborted)
            return false;
        try {
            post(outgoing);
            return true;
        }
        catch (error) {
            warn(`runtime transport post failed (dropping request ${id}): ${errorMessage(error)}`);
            entry.clientAborted = true;
            entry.controller.abort();
            entry.cancelBody?.();
            finalize();
            return false;
        }
    };
    entry.abortAsSuperseded = () => {
        if (entry.clientAborted || !isActive())
            return;
        writer.dispose();
        postFrame({
            type: 'stream-error',
            id,
            seq: seq + 1,
            message: 'runtime transport stream superseded by a newer request',
            code: 'aborted',
        });
        entry.clientAborted = true;
        entry.controller.abort();
        entry.cancelBody?.();
        finalize();
    };
    try {
        const response = await handleRequest(createFetchRequest(frame, url, entry.controller.signal));
        configureResponseFlow(entry, method, response);
        if (entry.clientAborted) {
            entry.cancellation = cancelResponseBody(response.body);
            finalize();
            return;
        }
        const started = postFrame({
            type: 'response-start',
            id,
            seq,
            status: response.status,
            ...(response.statusText ? { statusText: response.statusText } : {}),
            headers: toHeaderMap(response.headers),
        });
        if (!started) {
            entry.cancellation = cancelResponseBody(response.body);
            return;
        }
        if (!response.body) {
            finalize();
            postFrame({ type: 'stream-done', id, seq: seq + 1 });
            return;
        }
        if (!(await readResponseBody(response.body, { entry, writer, isClosed }))) {
            finalize();
            return;
        }
        writer.flush();
        finalize();
        postFrame({ type: 'stream-done', id, seq: seq + 1 });
    }
    catch (error) {
        const aborted = entry.clientAborted || isClosed();
        writer.flush();
        finalize();
        if (aborted)
            return;
        postFrame({
            type: 'stream-error',
            id,
            seq: seq + 1,
            message: errorMessage(error),
            ...(isAbortError(error) ? { code: 'aborted' } : {}),
        });
    }
}
//# sourceMappingURL=runtime-transport-request.js.map