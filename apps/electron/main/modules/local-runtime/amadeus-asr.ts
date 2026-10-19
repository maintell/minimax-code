export function pcm16LeToWav(pcm) {
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0, 'ascii');
    wav.writeUInt32LE(36 + pcm.length, 4);
    wav.write('WAVE', 8, 'ascii');
    wav.write('fmt ', 12, 'ascii');
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24);
    wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36, 'ascii');
    wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);
    return wav;
}
const TRANSCRIPTION_TIMEOUT_MS = 120000;
function isZeroStatusCode(value) {
    if (value === 0)
        return true;
    return typeof value === 'string' && value.trim() !== '' && Number(value) === 0;
}
function readAmadeusBusinessError(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return null;
    const value = payload;
    if (value.success === false) {
        return typeof value.error === 'string' && value.error.length > 0
            ? value.error
            : `Amadeus ASR business error${typeof value.error_code === 'number' ? ` (${value.error_code})` : ''}`;
    }
    if (value.status_code !== undefined && !isZeroStatusCode(value.status_code)) {
        return typeof value.status_msg === 'string' && value.status_msg.length > 0
            ? value.status_msg
            : `Amadeus ASR business error (${String(value.status_code)})`;
    }
    if (value.base_resp && typeof value.base_resp === 'object') {
        const baseResp = value.base_resp;
        if (baseResp.status_code !== undefined && !isZeroStatusCode(baseResp.status_code)) {
            return String(baseResp.status_msg ?? 'Amadeus ASR business error');
        }
    }
    return null;
}
function parseAmadeusPayload(raw) {
    const payload = JSON.parse(raw);
    const directError = readAmadeusBusinessError(payload);
    if (directError)
        throw new Error(directError);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const dataList = payload.data_list;
        const first = Array.isArray(dataList) ? dataList[0] : undefined;
        const dataValue = first && typeof first === 'object'
            ? first.data_value
            : undefined;
        if (typeof dataValue === 'string' && dataValue.length > 0) {
            const business = JSON.parse(dataValue);
            const nestedError = readAmadeusBusinessError(business);
            if (nestedError)
                throw new Error(nestedError);
        }
    }
    return payload;
}
export async function consumeAmadeusAsrSse(response, onText, onRawEvent, options) {
    if (!response.ok)
        throw new Error(`Amadeus ASR returned HTTP ${response.status}`);
    if (!response.body)
        throw new Error('Amadeus ASR returned an empty stream');
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
        const bodyText = await response.text();
        try {
            parseAmadeusPayload(bodyText);
        }
        catch (err) {
            if (err instanceof SyntaxError) {
                throw new Error('Amadeus ASR returned an invalid JSON response');
            }
            throw err;
        }
        throw new Error('Amadeus ASR returned a non-stream response');
    }
    const reader = response.body.getReader();
    let readerCancelPromise = null;
    const cancelReader = () => {
        readerCancelPromise ?? (readerCancelPromise = reader.cancel().catch(() => undefined));
        return readerCancelPromise;
    };
    const controller = new AbortController();
    const parentSignal = options?.signal;
    const onParentAbort = () => controller.abort(parentSignal?.reason ?? new DOMException('ASR request aborted', 'AbortError'));
    if (parentSignal?.aborted)
        onParentAbort();
    else
        parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new DOMException('ASR transcription timed out', 'TimeoutError')), options?.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS);
    const signal = controller.signal;
    const decoder = new TextDecoder();
    let buffer = '';
    let expectedIndex = 0;
    let transcript = '';
    let sawFinish = false;
    let completed = false;
    const processLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':'))
            return;
        if (!trimmed.startsWith('data:'))
            return;
        const raw = trimmed.slice(5).trim();
        onRawEvent?.(raw);
        const payload = parseAmadeusPayload(raw);
        const index = payload.index;
        const sequenceIndex = expectedIndex;
        if (index !== null &&
            index !== undefined &&
            (!Number.isInteger(index) || index !== sequenceIndex)) {
            throw new Error(`expected index ${expectedIndex} but received ${String(index)}`);
        }
        expectedIndex += 1;
        if (typeof payload.data === 'string')
            transcript += payload.data;
        const final = payload.finish === true;
        sawFinish || (sawFinish = final);
        onText(transcript, final, sequenceIndex);
    };
    try {
        while (true) {
            if (signal.aborted)
                throw signal.reason;
            const read = new Promise((resolve, reject) => {
                const onAbort = () => {
                    void cancelReader();
                    reject(signal.reason);
                };
                signal.addEventListener('abort', onAbort, { once: true });
                reader
                    .read()
                    .then(resolve, reject)
                    .finally(() => signal.removeEventListener('abort', onAbort));
            });
            const { value, done } = await read;
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines)
                processLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim())
            processLine(buffer);
        if (!sawFinish)
            throw new Error('Amadeus ASR stream ended before finish');
        completed = true;
    }
    finally {
        clearTimeout(timeout);
        parentSignal?.removeEventListener('abort', onParentAbort);
        if (!completed)
            await cancelReader();
        reader.releaseLock();
    }
}
