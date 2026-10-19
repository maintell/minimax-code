import { combineAbortSignals, createHttpServiceRequestSignal, decodeHttpResponse, HttpServiceTimeoutError, HttpStatusError, mergeClientHeaders, parseJsonBody, serializeHttpRequest, } from './http-json.js';
export function invokeHttpSse(options, route, req, callOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
        throw new Error('No fetch implementation is available for the thrift SSE client');
    }
    let closeRequested = false;
    let started = false;
    let settled = false;
    const closeController = new AbortController();
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise((resolve, reject) => {
        resolveClosed = () => {
            if (settled)
                return;
            settled = true;
            resolve();
        };
        rejectClosed = (error) => {
            if (settled)
                return;
            settled = true;
            reject(error);
        };
    });
    closed.catch(() => { });
    const frames = (async function* httpServiceSseFrames() {
        started = true;
        const signal = callOptions?.signal
            ? combineAbortSignals([callOptions.signal, closeController.signal])
            : closeController.signal;
        const requestSignal = createHttpServiceRequestSignal(route, { ...callOptions, signal });
        try {
            const url = new URL(route.path, normalizeBaseUrl(options.baseUrl));
            const headers = mergeClientHeaders(options.headers, callOptions?.headers);
            if (!headers.has('Accept'))
                headers.set('Accept', 'text/event-stream');
            const serialized = serializeHttpRequest(route, req, url, headers);
            if (serialized.body !== undefined && !headers.has('Content-Type')) {
                headers.set('Content-Type', 'application/json');
            }
            const response = await fetchImpl(url, {
                method: route.method === 'ANY' ? failAnyClientRoute(route) : route.method,
                headers,
                body: serialized.body,
                signal: requestSignal.signal,
            });
            if (!response.ok) {
                const responseText = await response.text();
                const errorBody = decodeSseErrorBody(route, parseJsonBody(responseText));
                const error = new HttpStatusError(route, response.status, responseText, errorBody);
                throw options.mapError ? options.mapError(error) : error;
            }
            yield* parseSseStream(route, response);
            resolveClosed();
        }
        catch (error) {
            const finalError = requestSignal.timedOut
                ? new HttpServiceTimeoutError(route, callOptions?.timeoutMs ?? 0)
                : error;
            if (closeRequested) {
                resolveClosed();
                return;
            }
            rejectClosed(finalError);
            throw finalError;
        }
        finally {
            requestSignal.dispose();
            // A consumer may stop at a yielded frame without calling close(). That
            // still releases the reader in parseSseStream, so the stream is closed.
            // Errors and external aborts have already rejected closed above.
            resolveClosed();
        }
    })();
    return {
        frames,
        close() {
            closeRequested = true;
            closeController.abort();
            if (!started)
                resolveClosed();
        },
        closed,
    };
}
async function* parseSseStream(route, response) {
    const body = response.body;
    if (!body)
        return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const state = { dataLines: [] };
    let buffer = '';
    let completedNormally = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value)
                buffer += decoder.decode(value, { stream: true });
            const read = readCompleteLines(buffer);
            buffer = read.remainder;
            for (const line of read.lines) {
                const dispatch = processSseLine(line, state);
                if (!dispatch)
                    continue;
                if (dispatch.kind === 'done') {
                    completedNormally = true;
                    return;
                }
                yield decodeSseFrame(route, dispatch.frame);
            }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
            const dispatch = processSseLine(buffer, state);
            if (dispatch?.kind === 'done') {
                completedNormally = true;
                return;
            }
            if (dispatch?.kind === 'frame')
                yield decodeSseFrame(route, dispatch.frame);
        }
        const dispatch = dispatchSseEvent(state);
        if (dispatch?.kind === 'done') {
            completedNormally = true;
            return;
        }
        if (dispatch?.kind === 'frame')
            yield decodeSseFrame(route, dispatch.frame);
        completedNormally = true;
    }
    finally {
        if (completedNormally) {
            reader.releaseLock();
        }
        else {
            await reader.cancel().catch(() => { });
        }
    }
}
function processSseLine(line, state) {
    if (line === '')
        return dispatchSseEvent(state);
    if (line.startsWith(':'))
        return undefined;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' '))
        value = value.slice(1);
    if (field === 'data')
        state.dataLines.push(value);
    return undefined;
}
function dispatchSseEvent(state) {
    if (state.dataLines.length === 0)
        return undefined;
    const data = state.dataLines.join('\n');
    state.dataLines = [];
    if (data.trim() === '[DONE]')
        return { kind: 'done' };
    return { kind: 'frame', frame: JSON.parse(data) };
}
function readCompleteLines(buffer) {
    const lines = [];
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (char === '\n') {
            const end = index > start && buffer[index - 1] === '\r' ? index - 1 : index;
            lines.push(buffer.slice(start, end));
            start = index + 1;
            continue;
        }
        if (char === '\r') {
            if (index + 1 >= buffer.length)
                break;
            lines.push(buffer.slice(start, index));
            if (buffer[index + 1] === '\n')
                index += 1;
            start = index + 1;
        }
    }
    return { lines, remainder: buffer.slice(start) };
}
function decodeSseFrame(route, frame) {
    return decodeHttpResponse({ ...route, responseSchema: route.frameSchema }, frame);
}
function decodeSseErrorBody(route, body) {
    if (body === undefined)
        return undefined;
    return decodeHttpResponse({ ...route, responseSchema: route.errorBodySchema }, body);
}
function failAnyClientRoute(route) {
    throw new Error(`Cannot invoke api.any route ${route.path} without a concrete HTTP method`);
}
function normalizeBaseUrl(baseUrl) {
    return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}
//# sourceMappingURL=sse.js.map