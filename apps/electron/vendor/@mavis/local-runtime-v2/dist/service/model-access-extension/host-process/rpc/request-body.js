import { randomUUID } from 'node:crypto';
import { observeModelAccessWork } from '../../core/settlement.js';
export const REQUEST_BODY_MAX_BYTES = 64 * 1024 * 1024;
export const REQUEST_BODY_GLOBAL_BYTES = 128 * 1024 * 1024;
export const REQUEST_BODY_CHUNK_BYTES = 1024 * 1024;
export const REQUEST_BODY_TIMEOUT_MS = 30_000;
export function requestBodyError(code) {
    const error = Object.assign(new Error(code), { code });
    Object.defineProperty(error, 'hostFailure', { value: true, enumerable: false });
    return error;
}
export async function discardRequestBody(peer, transportRef, ref) {
    if (!ref)
        return;
    try {
        await peer.request('body.discard', { ref, transportRef }, { timeoutMs: 1_000 });
    }
    catch {
        /* Child expiry remains the fallback if IPC is closed. */
    }
}
async function cancelReader(reader) {
    try {
        await reader.cancel();
    }
    catch {
        /* Preserve the original upload failure. */
    }
}
export async function uploadRequestBody(peer, transportRef, body, control) {
    const { signal, maxBytes = REQUEST_BODY_MAX_BYTES } = control;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > REQUEST_BODY_MAX_BYTES)
        throw requestBodyError('request_body_limit_invalid');
    const ref = randomUUID();
    const reader = body.getReader();
    const cancelled = () => {
        observeModelAccessWork(cancelReader(reader));
    };
    signal.addEventListener('abort', cancelled, { once: true });
    let succeeded = false;
    try {
        signal.throwIfAborted();
        await peer.request('body.begin', { ref, transportRef, maxBytes }, { signal });
        let bytes = 0;
        let sequence = 0;
        for (;;) {
            signal.throwIfAborted();
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done)
                break;
            bytes += next.value.byteLength;
            if (bytes > maxBytes)
                throw requestBodyError('request_body_too_large');
            for (let offset = 0; offset < next.value.byteLength; offset += REQUEST_BODY_CHUNK_BYTES) {
                const chunk = next.value.subarray(offset, offset + REQUEST_BODY_CHUNK_BYTES);
                await peer.request('body.chunk', {
                    ref,
                    transportRef,
                    sequence: sequence++,
                    data: Buffer.from(chunk).toString('base64'),
                }, { signal });
            }
        }
        await peer.request('body.end', { ref, transportRef, bytes, sequence }, { signal });
        succeeded = true;
        return { ref };
    }
    finally {
        signal.removeEventListener('abort', cancelled);
        if (!succeeded) {
            observeModelAccessWork(cancelReader(reader));
            await discardRequestBody(peer, transportRef, ref);
        }
        reader.releaseLock();
    }
}
//# sourceMappingURL=request-body.js.map