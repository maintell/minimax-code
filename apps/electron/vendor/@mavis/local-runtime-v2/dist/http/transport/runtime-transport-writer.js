import { RUNTIME_TRANSPORT_MAX_STREAM_WINDOW } from '@mavis/shared/runtime-transport';
import { concatChunks } from './runtime-transport-response.js';
export function createRuntimeTransportWriter(options) {
    const { state, isClosed, postChunk, streamWindow, coalesceIntervalMs, maxFrameBytes } = options;
    let buffered = [];
    let bufferedBytes = 0;
    let flushTimer = null;
    let flushPending = false;
    let creditWaiter = null;
    const wakeCreditWaiter = () => {
        const resolve = creditWaiter;
        creditWaiter = null;
        resolve?.();
    };
    const clearFlushTimer = () => {
        if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
    };
    const flush = () => {
        clearFlushTimer();
        if (bufferedBytes === 0 || state.clientAborted)
            return;
        if (state.streamCredits !== null && state.streamCredits <= 0) {
            flushPending = true;
            return;
        }
        flushPending = false;
        if (state.streamCredits !== null)
            state.streamCredits -= 1;
        const payload = concatChunks(buffered, bufferedBytes);
        buffered = [];
        bufferedBytes = 0;
        postChunk(payload);
    };
    const enqueueUnwindowedChunk = (chunk) => {
        let offset = 0;
        while (offset < chunk.byteLength) {
            const available = Math.max(1, maxFrameBytes - bufferedBytes);
            const end = Math.min(chunk.byteLength, offset + available);
            // MessagePort clones the backing ArrayBuffer, so each frame owns bounded storage.
            const slice = new Uint8Array(chunk.subarray(offset, end));
            buffered.push(slice);
            bufferedBytes += slice.byteLength;
            offset = end;
            if (bufferedBytes >= maxFrameBytes || coalesceIntervalMs <= 0)
                flush();
        }
        if (bufferedBytes > 0 && flushTimer === null) {
            flushTimer = setTimeout(flush, coalesceIntervalMs);
        }
    };
    const enqueueChunk = (chunk) => {
        // Finite responses can arrive in one large read; windowed SSE retains its
        // existing credit-aware coalescing semantics.
        if (state.streamCredits === null && chunk.byteLength > 0) {
            enqueueUnwindowedChunk(chunk);
            return;
        }
        buffered.push(chunk);
        bufferedBytes += chunk.byteLength;
        if (bufferedBytes >= maxFrameBytes || coalesceIntervalMs <= 0) {
            flush();
            return;
        }
        if (flushTimer === null) {
            flushTimer = setTimeout(flush, coalesceIntervalMs);
        }
    };
    state.grantStreamCredits = (credits) => {
        if (state.clientAborted || state.streamCredits === null)
            return;
        state.streamCredits = Math.min(streamWindow ?? RUNTIME_TRANSPORT_MAX_STREAM_WINDOW, state.streamCredits + credits);
        if (flushPending)
            flush();
        if (state.streamCredits > 0)
            wakeCreditWaiter();
    };
    state.releaseBackpressure = wakeCreditWaiter;
    const waitForCredit = () => new Promise((resolve) => {
        creditWaiter = resolve;
    });
    const waitForReadCapacity = async () => {
        while (!isClosed() && !state.clientAborted && state.streamCredits === 0) {
            await waitForCredit();
        }
        return !isClosed() && !state.clientAborted;
    };
    return {
        enqueueChunk,
        flush,
        waitForReadCapacity,
        dispose() {
            clearFlushTimer();
            wakeCreditWaiter();
            buffered = [];
            bufferedBytes = 0;
            state.grantStreamCredits = undefined;
            state.releaseBackpressure = undefined;
        },
    };
}
//# sourceMappingURL=runtime-transport-writer.js.map