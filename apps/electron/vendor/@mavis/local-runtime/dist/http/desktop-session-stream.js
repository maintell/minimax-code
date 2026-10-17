import { asObject, readNumber, readString } from './desktop-session-mapper-support.js';
export async function openLocalSessionStream(localApiResponse, pathOrUrl, init) {
    const response = await localApiResponse(pathOrUrl, init);
    if (!response.ok) {
        return {
            ok: false,
            status: response.status,
            body: await readStreamErrorBody(response),
        };
    }
    return { ok: true, source: streamSessionFrames(response, init.signal) };
}
async function readStreamErrorBody(response) {
    const text = await response.text().catch(() => '');
    let parsed = {};
    try {
        parsed = text ? asObject(JSON.parse(text)) : {};
    }
    catch {
        parsed = {};
    }
    const code = readNumber(parsed.code) ?? readNumber(parsed.errorCode) ?? response.status;
    const message = (readString(parsed.message) ?? readString(parsed.error) ?? text) ||
        response.statusText ||
        'SSE open failed';
    return {
        sseErrorCode: readNumber(parsed.sseErrorCode ?? parsed.sse_error_code) ?? 0,
        code,
        key: readString(parsed.key) ?? readString(parsed.code) ?? 'LOCAL_RUNTIME_STREAM_OPEN_FAILED',
        message,
        detail: readString(parsed.detail),
    };
}
function streamSessionFrames(response, signal) {
    const body = response.body;
    if (!body)
        return [];
    const reader = body.getReader();
    const frames = readSessionFrames(reader);
    const iterator = frames[Symbol.asyncIterator]();
    let cancelPromise;
    let finished = false;
    let started = false;
    const cancelReader = () => {
        cancelPromise ??= reader.cancel(signal?.reason).catch(() => { });
        return cancelPromise;
    };
    function handleAbort() {
        void cancelReader();
    }
    function finish() {
        if (finished)
            return;
        finished = true;
        signal?.removeEventListener('abort', handleAbort);
        if (!started)
            reader.releaseLock();
    }
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted)
        handleAbort();
    const source = {
        [Symbol.asyncIterator]: () => source,
        async next() {
            started = true;
            try {
                const next = await iterator.next();
                if (next.done)
                    finish();
                return next;
            }
            catch (error) {
                finish();
                throw error;
            }
        },
        async return() {
            await cancelReader();
            try {
                return (await iterator.return?.()) ?? { done: true, value: undefined };
            }
            finally {
                finish();
            }
        },
    };
    return source;
}
async function* readSessionFrames(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    const state = { dataLines: [] };
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex = buffer.search(/\r?\n/u);
            while (newlineIndex >= 0) {
                const rawLine = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(rawLine.endsWith('\r') ? newlineIndex + 2 : newlineIndex + 1);
                const frame = consumeSseLine(rawLine.replace(/\r$/u, ''), state);
                if (frame)
                    yield frame;
                newlineIndex = buffer.search(/\r?\n/u);
            }
        }
        const tail = decoder.decode();
        if (tail)
            buffer += tail;
        if (buffer) {
            const frame = consumeSseLine(buffer.replace(/\r$/u, ''), state);
            if (frame)
                yield frame;
        }
        if (state.dataLines.length > 0) {
            yield flushSseFrame(state);
        }
    }
    finally {
        reader.releaseLock();
    }
}
function consumeSseLine(line, state) {
    if (line === '') {
        if (state.dataLines.length === 0)
            return undefined;
        return flushSseFrame(state);
    }
    if (line.startsWith(':'))
        return undefined;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /u, '') : '';
    if (field === 'data')
        state.dataLines.push(value);
    else if (field === 'event')
        state.event = value;
    else if (field === 'id')
        state.id = value;
    return undefined;
}
function flushSseFrame(state) {
    const frame = {
        dataJson: state.dataLines.join('\n'),
        ...(state.id ? { cursor: state.id } : {}),
        ...(state.event ? { eventJson: JSON.stringify({ event: state.event }) } : {}),
    };
    state.dataLines = [];
    state.event = undefined;
    state.id = undefined;
    return frame;
}
//# sourceMappingURL=desktop-session-stream.js.map