import { WORKSPACE_GIT_OBSERVATION_HEADER, WORKSPACE_GIT_OBSERVATION_MAX_BYTES, } from './workspace-git-observation.js';
/**
 * Fetch shim over the runtime transport frame protocol.
 *
 * `createRuntimeTransportFetch` returns a function with real-`fetch`
 * semantics whose "wire" is a `RuntimeTransportLink` (a MessagePort in
 * production) instead of HTTP. It synthesizes a spec-faithful `Response`
 * (`.ok` / `.status` / `.headers` / `.text()` / `.body.getReader()`), so
 * existing HTTP/SSE clients — the generated DesktopService client,
 * `invokeHttpSse`, the UI SSE parsers — consume it without changes.
 *
 * Error mapping mirrors the app:// protocol handler so the transport swap is
 * behavior-preserving:
 * - `stream-error` before `response-start`: code `aborted` -> 499 null body;
 *   anything else -> 502 JSON `{ error, message }` with
 *   `local_runtime_unavailable` as the default code.
 * - `stream-error` after `response-start`: the body stream errors.
 * - Caller aborts (init.signal) reject with an `AbortError`, like real fetch,
 *   and post an `abort` frame so the host releases the in-flight request.
 * - Body cancellation (`reader.cancel()`) posts an `abort` frame too —
 *   per-stream cancel; turn aborts stay a business `POST .../abort` request.
 */
import { RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW } from './frames.js';
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const DEFAULT_ERROR_CODE = 'local_runtime_unavailable';
const ABORTED_ERROR_CODE = 'aborted';
const TRACE_ID_HEADER = 'x-trace-id';
const DIAGNOSTIC_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function defaultGenerateRequestId() {
    return globalThis.crypto.randomUUID();
}
function toAbortError(reason) {
    if (reason !== undefined && reason !== null)
        return reason;
    return new DOMException('This operation was aborted', 'AbortError');
}
function toHeaderMap(init) {
    const map = {};
    if (!init)
        return map;
    const headers = init instanceof Headers ? init : new Headers(init);
    headers.forEach((value, key) => {
        map[key] = value;
    });
    return map;
}
function toBytes(payload) {
    return typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
}
async function normalizeBody(body, headers) {
    if (body === undefined || body === null)
        return undefined;
    if (typeof body === 'string')
        return body;
    if (body instanceof Uint8Array)
        return body;
    if (body instanceof ArrayBuffer)
        return new Uint8Array(body.slice(0));
    if (ArrayBuffer.isView(body)) {
        return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    if (body instanceof URLSearchParams) {
        if (!hasHeader(headers, 'content-type')) {
            headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        }
        return body.toString();
    }
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
        if (body.type && !hasHeader(headers, 'content-type')) {
            headers['content-type'] = body.type;
        }
        return new Uint8Array(await body.arrayBuffer());
    }
    throw new TypeError('runtime transport fetch does not support streaming or multipart request bodies; ' +
        'large payloads must go through the asset store');
}
function hasHeader(headers, name) {
    const lower = name.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}
function readHeader(headers, name) {
    const lower = name.toLowerCase();
    return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
}
function toDiagnosticIdentifier(value) {
    return value && DIAGNOSTIC_IDENTIFIER_RE.test(value) ? value : undefined;
}
function toDiagnosticPathname(url) {
    try {
        return new URL(url, 'http://runtime-transport.invalid').pathname || '/';
    }
    catch {
        return '/';
    }
}
function diagnosticReasonFromStreamError(frame, portLost) {
    if (portLost || frame.code === 'runtime_lost')
        return 'runtime_lost';
    return frame.code === ABORTED_ERROR_CODE ? 'remote_aborted' : 'remote_error';
}
function hasEventStreamHeader(headers) {
    return Object.entries(headers).some(([key, value]) => (key.toLowerCase() === 'accept' || key.toLowerCase() === 'content-type') &&
        value.toLowerCase().includes('text/event-stream'));
}
function hasEventStreamContentType(headers) {
    return Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'content-type' && value.toLowerCase().includes('text/event-stream'));
}
async function normalizeFetchArgs(input, init) {
    if (typeof Request !== 'undefined' && input instanceof Request) {
        const method = (init?.method ?? input.method).toUpperCase();
        const headers = toHeaderMap(init?.headers ?? input.headers);
        let body;
        if (init && 'body' in init) {
            body = await normalizeBody(init.body, headers);
        }
        else if (input.body !== null) {
            body = new Uint8Array(await input.arrayBuffer());
        }
        if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
            throw new TypeError(`Request with GET/HEAD method cannot have body.`);
        }
        return {
            method,
            url: input.url,
            headers,
            body,
            signal: init?.signal ?? input.signal ?? undefined,
        };
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = toHeaderMap(init?.headers);
    const body = await normalizeBody(init?.body, headers);
    if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
        throw new TypeError(`Request with GET/HEAD method cannot have body.`);
    }
    return {
        method,
        url: typeof input === 'string' ? input : input.toString(),
        headers,
        body,
        signal: init?.signal ?? undefined,
    };
}
function synthesizeErrorResponse(frame) {
    if (frame.code === ABORTED_ERROR_CODE) {
        return new Response(null, { status: 499 });
    }
    return new Response(JSON.stringify({ error: frame.code ?? DEFAULT_ERROR_CODE, message: frame.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
function synthesizeResponse(frame, body, onMalformed) {
    try {
        return new Response(body, {
            status: frame.status,
            ...(frame.statusText !== undefined ? { statusText: frame.statusText } : {}),
            headers: frame.headers,
        });
    }
    catch (error) {
        // Defense in depth behind the boundary validator: a frame that slips
        // through with Response-hostile fields (illegal header names, ...) must
        // degrade to a transport error instead of throwing inside a MessagePort
        // message handler.
        onMalformed?.();
        return synthesizeErrorResponse({
            type: 'stream-error',
            id: frame.id,
            seq: frame.seq,
            message: `malformed response-start frame: ${error instanceof Error ? error.message : String(error)}`,
        });
    }
}
/**
 * Creates a fetch-compatible function that tunnels requests over `link`.
 * One instance shares a single lazy link subscription across all in-flight
 * requests and routes server frames back by request id.
 */
export function createRuntimeTransportFetch(options) {
    const { link } = options;
    const generateRequestId = options.generateRequestId ?? defaultGenerateRequestId;
    const onRequestComplete = options.onRequestComplete;
    const debugSink = options.debugSink;
    const diagnosticSink = options.diagnosticSink;
    function isDebugEnabled() {
        if (!debugSink)
            return false;
        if (!debugSink.isEnabled)
            return true;
        try {
            return debugSink.isEnabled();
        }
        catch {
            return false;
        }
    }
    function emitDebug(event) {
        if (!isDebugEnabled())
            return;
        if (!debugSink)
            return;
        try {
            debugSink.emit(event);
        }
        catch {
            // Debug observers must never enter the transport control path.
        }
    }
    function emitDiagnostic(createEvent) {
        if (!diagnosticSink)
            return;
        try {
            diagnosticSink.onDiagnosticEvent(createEvent());
        }
        catch {
            // Diagnostics must never enter the transport control path.
        }
    }
    function reportTransportError(failure) {
        try {
            options.onTransportError?.(failure);
        }
        catch {
            // Observability must never enter the transport control path.
        }
    }
    function reportAndEmitTransportError(failure, id, message) {
        reportTransportError(failure);
        if (!isDebugEnabled())
            return;
        emitDebug({
            type: 'transport-error',
            id,
            reasonCode: failure.reasonCode,
            phase: failure.phase,
            requestKind: failure.requestKind,
            ...(message !== undefined ? { message } : {}),
            timestampMs: Date.now(),
        });
    }
    const routes = new Map();
    let portLostRequestIds;
    let unsubscribe = null;
    let unsubscribeLost = null;
    function dispatch(frame) {
        routes.get(frame.id)?.(frame);
    }
    function dispatchLost(info) {
        const message = info.message ?? 'runtime transport lost';
        const trackPortLoss = isDebugEnabled() || diagnosticSink !== undefined;
        if (trackPortLoss) {
            portLostRequestIds = new Set();
            emitDiagnostic(() => ({
                type: 'port-lost',
                timestampMs: Date.now(),
                activeRequestCount: routes.size,
            }));
            emitDebug({ type: 'port-lost', message, timestampMs: Date.now() });
        }
        try {
            for (const [id, onFrame] of [...routes]) {
                if (trackPortLoss)
                    portLostRequestIds?.add(id);
                onFrame({ type: 'stream-error', id, seq: 0, message, code: 'runtime_lost' });
            }
        }
        finally {
            if (trackPortLoss)
                portLostRequestIds = undefined;
        }
    }
    function attachRoute(id, onFrame) {
        routes.set(id, onFrame);
        if (!unsubscribe)
            unsubscribe = link.subscribe(dispatch);
        if (!unsubscribeLost)
            unsubscribeLost = link.subscribeLost(dispatchLost);
    }
    function detachRoute(id) {
        routes.delete(id);
        if (routes.size === 0) {
            if (unsubscribe) {
                unsubscribe();
                unsubscribe = null;
            }
            if (unsubscribeLost) {
                unsubscribeLost();
                unsubscribeLost = null;
            }
        }
    }
    return async function runtimeTransportFetch(input, init) {
        const normalized = await normalizeFetchArgs(input, init);
        const { method, url, headers, body, signal } = normalized;
        if (signal?.aborted)
            throw toAbortError(signal.reason);
        const id = generateRequestId();
        if (!hasHeader(headers, TRACE_ID_HEADER))
            headers[TRACE_ID_HEADER] = id;
        const traceId = toDiagnosticIdentifier(readHeader(headers, TRACE_ID_HEADER));
        const pathname = toDiagnosticPathname(url);
        const requestStartedAtMs = onRequestComplete ? Date.now() : 0;
        return await new Promise((resolve, reject) => {
            /** Response resolved (response-start seen or synthesized). */
            let responseSettled = false;
            /** Body finished (closed, errored or cancelled); route detached. */
            let bodyFinished = false;
            let bodyController = null;
            let lastSeq = -1;
            let responseStatus = 0;
            let workspaceGitObservation;
            const streamWindow = RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW;
            let outstandingStreamCredits = streamWindow;
            let flowControlledResponse = false;
            let requestKind = hasEventStreamHeader(headers)
                ? 'stream'
                : 'request';
            let firstDiagnosticChunkSeen = false;
            const diagnosticRequest = () => ({
                id,
                ...(traceId ? { traceId } : {}),
                method,
                pathname,
                requestKind,
            });
            function reportRequestComplete() {
                const observer = onRequestComplete;
                if (!observer)
                    return;
                const completedRequest = {
                    method,
                    url,
                    status: responseStatus,
                    durationMs: Math.max(0, Date.now() - requestStartedAtMs),
                    requestKind,
                    ...(workspaceGitObservation ? { workspaceGitObservation } : {}),
                };
                try {
                    globalThis.setTimeout(() => {
                        try {
                            void Promise.resolve(observer(completedRequest)).catch(() => { });
                        }
                        catch {
                            // Observability must never enter the transport control path.
                        }
                    }, 0);
                }
                catch {
                    // Scheduling telemetry is best-effort and must not affect fetch completion.
                }
            }
            function finish(terminal) {
                if (bodyFinished)
                    return;
                bodyFinished = true;
                if (signal)
                    signal.removeEventListener('abort', onAbort);
                detachRoute(id);
                emitDiagnostic(() => ({
                    ...diagnosticRequest(),
                    type: 'terminal',
                    terminal: terminal.type,
                    ...(responseStatus ? { status: responseStatus } : {}),
                    ...(terminal.reasonCode ? { reasonCode: terminal.reasonCode } : {}),
                    timestampMs: Date.now(),
                    activeRequestCount: routes.size,
                }));
                reportRequestComplete();
            }
            function failBody(error, terminal) {
                if (bodyFinished)
                    return;
                finish(terminal);
                try {
                    bodyController?.error(error);
                }
                catch {
                    // Stream may already be closed by the consumer; nothing to do.
                }
            }
            /**
             * Fire-and-forget frame send. `link.post` may throw synchronously
             * (e.g. the preload bridge throws while the transport port is down);
             * for abort/cancel notifications that is best-effort — the host side
             * reaps the request when the port dies anyway.
             */
            function postQuiet(frame) {
                try {
                    link.post(frame);
                }
                catch {
                    // Port gone — the down signal / host port-close reaps the request.
                }
            }
            /**
             * Keep host output aligned with the ReadableStream's remaining queue
             * capacity. Credits are granted only after queued chunks are consumed;
             * receiving a frame merely transfers one existing credit into the
             * renderer queue and must not grow the window.
             */
            function replenishStreamCredits() {
                if (!flowControlledResponse || bodyFinished || !bodyController)
                    return;
                const desiredSize = Math.max(0, Math.floor(bodyController.desiredSize ?? 0));
                const credits = desiredSize - outstandingStreamCredits;
                if (credits <= 0)
                    return;
                // Increment before posting because an in-memory link may synchronously
                // dispatch the resulting host frame back into this route.
                outstandingStreamCredits += credits;
                try {
                    link.post({ type: 'stream-credit', id, credits });
                }
                catch {
                    outstandingStreamCredits -= credits;
                    // Port gone — the down signal / host port-close reaps the request.
                }
            }
            function onAbort() {
                if (isDebugEnabled()) {
                    emitDebug({
                        type: 'request-abort',
                        id,
                        reason: 'client_aborted',
                        timestampMs: Date.now(),
                    });
                }
                postQuiet({ type: 'abort', id, reason: 'client_aborted' });
                if (!responseSettled) {
                    responseSettled = true;
                    finish({ type: 'abort', reasonCode: 'client_aborted' });
                    reject(toAbortError(signal?.reason));
                    return;
                }
                failBody(toAbortError(signal?.reason), { type: 'abort', reasonCode: 'client_aborted' });
            }
            function onFrame(frame) {
                switch (frame.type) {
                    case 'response-start': {
                        if (responseSettled)
                            return;
                        try {
                            const value = frame.headers[WORKSPACE_GIT_OBSERVATION_HEADER];
                            if (typeof value === 'string' && value.length <= WORKSPACE_GIT_OBSERVATION_MAX_BYTES)
                                workspaceGitObservation = value;
                        }
                        catch {
                            /* Optional metadata never affects transport admission. */
                        }
                        responseSettled = true;
                        lastSeq = frame.seq;
                        flowControlledResponse = hasEventStreamContentType(frame.headers);
                        if (flowControlledResponse)
                            requestKind = 'stream';
                        emitDiagnostic(() => ({
                            ...diagnosticRequest(),
                            type: 'response-start',
                            status: frame.status,
                            timestampMs: Date.now(),
                            activeRequestCount: routes.size,
                        }));
                        if (isDebugEnabled()) {
                            emitDebug({
                                type: 'response-start',
                                id,
                                status: frame.status,
                                ...(frame.statusText !== undefined ? { statusText: frame.statusText } : {}),
                                headers: { ...frame.headers },
                                timestampMs: Date.now(),
                            });
                        }
                        let responseMalformed = false;
                        const reportMalformedResponse = () => {
                            responseMalformed = true;
                            reportAndEmitTransportError({
                                reasonCode: 'response_malformed',
                                phase: 'response',
                                requestKind,
                            }, id);
                            postQuiet({ type: 'abort', id, reason: 'malformed_response' });
                        };
                        if (NULL_BODY_STATUSES.has(frame.status) || method === 'HEAD') {
                            const response = synthesizeResponse(frame, null, reportMalformedResponse);
                            responseStatus = response.status;
                            if (!responseMalformed && isDebugEnabled()) {
                                emitDebug({ type: 'response-complete', id, timestampMs: Date.now() });
                            }
                            finish(responseMalformed
                                ? { type: 'error', reasonCode: 'response_malformed' }
                                : { type: 'complete' });
                            resolve(response);
                            return;
                        }
                        const stream = new ReadableStream({
                            start(controller) {
                                bodyController = controller;
                            },
                            pull() {
                                replenishStreamCredits();
                            },
                            cancel() {
                                if (bodyFinished)
                                    return;
                                finish({ type: 'abort', reasonCode: 'stream_cancelled' });
                                if (isDebugEnabled()) {
                                    emitDebug({
                                        type: 'request-abort',
                                        id,
                                        reason: 'stream_cancelled',
                                        timestampMs: Date.now(),
                                    });
                                }
                                postQuiet({ type: 'abort', id, reason: 'stream_cancelled' });
                            },
                        }, { highWaterMark: flowControlledResponse ? streamWindow : 1 });
                        const response = synthesizeResponse(frame, stream, reportMalformedResponse);
                        responseStatus = response.status;
                        if (responseMalformed)
                            finish({ type: 'error', reasonCode: 'response_malformed' });
                        resolve(response);
                        return;
                    }
                    case 'stream-chunk': {
                        if (!responseSettled || bodyFinished)
                            return;
                        if (frame.seq <= lastSeq)
                            return; // wire duplicate — no new host credit was spent
                        if (frame.seq !== lastSeq + 1) {
                            reportAndEmitTransportError({
                                reasonCode: 'seq_gap',
                                phase: 'stream',
                                requestKind,
                            }, id);
                            postQuiet({ type: 'abort', id, reason: 'stream_seq_gap' });
                            failBody(new Error(`runtime_transport_seq_gap: expected seq ${lastSeq + 1}, got ${frame.seq}`), { type: 'error', reasonCode: 'seq_gap' });
                            return;
                        }
                        lastSeq = frame.seq;
                        if (!firstDiagnosticChunkSeen) {
                            firstDiagnosticChunkSeen = true;
                            emitDiagnostic(() => ({
                                ...diagnosticRequest(),
                                type: 'response-chunk',
                                seq: frame.seq,
                                timestampMs: Date.now(),
                                activeRequestCount: routes.size,
                            }));
                        }
                        if (isDebugEnabled()) {
                            emitDebug({
                                type: 'response-chunk',
                                id,
                                seq: frame.seq,
                                payload: frame.payload instanceof Uint8Array ? frame.payload.slice() : frame.payload,
                                timestampMs: Date.now(),
                            });
                        }
                        if (flowControlledResponse && outstandingStreamCredits > 0) {
                            outstandingStreamCredits -= 1;
                        }
                        try {
                            bodyController?.enqueue(toBytes(frame.payload));
                            replenishStreamCredits();
                        }
                        catch {
                            // Consumer closed the stream between cancel and frame delivery.
                        }
                        return;
                    }
                    case 'stream-done': {
                        if (!responseSettled) {
                            // Protocol violation: body ended before a status line arrived.
                            reportAndEmitTransportError({
                                reasonCode: 'response_missing',
                                phase: 'response',
                                requestKind,
                            }, id, 'runtime transport closed before response-start');
                            responseSettled = true;
                            responseStatus = 502;
                            finish({ type: 'error', reasonCode: 'response_missing' });
                            resolve(synthesizeErrorResponse({
                                type: 'stream-error',
                                id,
                                seq: frame.seq,
                                message: 'runtime transport closed before response-start',
                            }));
                            return;
                        }
                        if (bodyFinished)
                            return;
                        // A terminal frame must be exactly the next seq. A stale/colliding
                        // seq is failed like a gap instead of being dropped: dropping the
                        // only terminal frame would leave the body open forever.
                        if (frame.seq !== lastSeq + 1) {
                            reportAndEmitTransportError({
                                reasonCode: 'seq_gap',
                                phase: 'stream',
                                requestKind,
                            }, id);
                            postQuiet({ type: 'abort', id, reason: 'stream_seq_gap' });
                            failBody(new Error(`runtime_transport_seq_gap: expected seq ${lastSeq + 1}, got ${frame.seq}`), { type: 'error', reasonCode: 'seq_gap' });
                            return;
                        }
                        lastSeq = frame.seq;
                        if (isDebugEnabled()) {
                            emitDebug({ type: 'response-complete', id, timestampMs: Date.now() });
                        }
                        finish({ type: 'complete' });
                        try {
                            bodyController?.close();
                        }
                        catch {
                            // Stream already closed/errored; nothing to do.
                        }
                        return;
                    }
                    case 'stream-error': {
                        if (!responseSettled) {
                            if (isDebugEnabled()) {
                                emitDebug({
                                    type: 'transport-error',
                                    id,
                                    reasonCode: frame.code ?? DEFAULT_ERROR_CODE,
                                    phase: portLostRequestIds?.has(id) ? 'connection' : 'response',
                                    requestKind,
                                    message: frame.message,
                                    timestampMs: Date.now(),
                                });
                            }
                            responseSettled = true;
                            responseStatus = frame.code === ABORTED_ERROR_CODE ? 499 : 502;
                            const portLost = portLostRequestIds?.has(id) === true;
                            finish({
                                type: frame.code === ABORTED_ERROR_CODE ? 'abort' : 'error',
                                reasonCode: diagnosticReasonFromStreamError(frame, portLost),
                            });
                            resolve(synthesizeErrorResponse(frame));
                            return;
                        }
                        if (isDebugEnabled()) {
                            emitDebug({
                                type: 'transport-error',
                                id,
                                reasonCode: frame.code ?? DEFAULT_ERROR_CODE,
                                phase: portLostRequestIds?.has(id) ? 'connection' : 'stream',
                                requestKind,
                                message: frame.message,
                                timestampMs: Date.now(),
                            });
                        }
                        const portLost = portLostRequestIds?.has(id) === true;
                        failBody(new Error(frame.message || 'runtime_transport_stream_error'), {
                            type: frame.code === ABORTED_ERROR_CODE ? 'abort' : 'error',
                            reasonCode: diagnosticReasonFromStreamError(frame, portLost),
                        });
                    }
                }
            }
            attachRoute(id, onFrame);
            if (signal)
                signal.addEventListener('abort', onAbort, { once: true });
            emitDiagnostic(() => ({
                ...diagnosticRequest(),
                type: 'request-start',
                timestampMs: Date.now(),
                activeRequestCount: routes.size,
            }));
            if (isDebugEnabled()) {
                emitDebug({
                    type: 'request-start',
                    id,
                    method,
                    url,
                    headers: { ...headers },
                    ...(body !== undefined ? { body: body instanceof Uint8Array ? body.slice() : body } : {}),
                    requestKind,
                    timestampMs: Date.now(),
                });
            }
            try {
                link.post({
                    type: 'request',
                    id,
                    method,
                    url,
                    headers,
                    streamWindow,
                    ...(body !== undefined ? { body } : {}),
                });
            }
            catch (error) {
                // The transport is down (e.g. the preload bridge throws while no
                // port is attached). Fail like a lost runtime — an HTTP-shaped 502
                // response, with the route/listeners fully released — instead of
                // leaking the route and surfacing a bare exception.
                responseSettled = true;
                responseStatus = 502;
                finish({ type: 'error', reasonCode: 'request_post_failed' });
                const message = error instanceof Error ? error.message : String(error);
                reportAndEmitTransportError({
                    reasonCode: 'request_post_failed',
                    phase: 'request',
                    requestKind,
                }, id, message);
                resolve(synthesizeErrorResponse({
                    type: 'stream-error',
                    id,
                    seq: 0,
                    message,
                    code: 'runtime_lost',
                }));
            }
        });
    };
}
//# sourceMappingURL=fetch-shim.js.map