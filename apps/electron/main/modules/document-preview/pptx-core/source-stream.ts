import { createHash } from "node:crypto";
import { safePreviewDiagnosticV1 } from "@mavis/shared/document-preview";
import { decodeBoundWorkerMessage, isAckMessage, abortMessage, helloMessage, PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1, PPTX_CORE_STREAM_CHUNK_BYTES_V1, chunkMessage, endMessage } from "./protocol";
function failure(code, message) {
    return {
        ok: false,
        error: {
            schema: 'mavis.preview_error.v1',
            code,
            message: safePreviewDiagnosticV1(code, message),
            retryable: false,
        },
    };
}
function waitForAckSignal(signal, register) {
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('source_stream_cancelled'));
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        register(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        });
    });
}
/**
 * Stream one original source lease with a strict two-chunk ACK window. The
 * returned result is terminal for this data plane; no large byte array crosses
 * ordinary invoke IPC.
 */
export async function streamPptxCoreSource(binding) {
    const { descriptor, controller, sourceLease, port } = binding;
    if (!binding.markStreaming()) {
        await binding.terminate();
        return failure('invalid_request', 'PPTX core source stream was already bound');
    }
    const outstanding = [];
    let notifyAck = null;
    let nextSequence = 1;
    let terminalReason = null;
    const wake = () => {
        const notify = notifyAck;
        notifyAck = null;
        notify?.();
    };
    const abort = (reason) => {
        if (!terminalReason)
            terminalReason = reason;
        controller.abort();
        wake();
    };
    const waitForNextAck = () => waitForAckSignal(controller.signal, (resolve) => {
        notifyAck = resolve;
    });
    port.on('message', (event) => {
        try {
            const message = decodeBoundWorkerMessage(event.data, descriptor);
            if (isAckMessage(message)) {
                if (outstanding[0] !== message.sequence) {
                    abort('invalid_protocol');
                    return;
                }
                outstanding.shift();
                wake();
                return;
            }
            abort(message.reason);
        }
        catch {
            abort('invalid_protocol');
        }
    });
    port.on('close', () => abort('cancelled'));
    const postAbort = (reason) => {
        try {
            port.postMessage(abortMessage(descriptor, nextSequence, reason));
        }
        catch {
            // The consumer may already have closed its port.
        }
    };
    try {
        port.start();
        port.postMessage(helloMessage(descriptor));
        const hash = createHash('sha256');
        let offset = 0;
        while (offset < descriptor.sourceSizeBytes) {
            while (outstanding.length >= PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1) {
                await waitForNextAck();
            }
            if (controller.signal.aborted)
                throw new Error('source_stream_cancelled');
            const bytes = await sourceLease.read(offset, PPTX_CORE_STREAM_CHUNK_BYTES_V1, controller.signal);
            if (bytes.byteLength === 0)
                throw new Error('source_stream_truncated');
            hash.update(bytes);
            const transfer = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(transfer).set(bytes);
            port.postMessage(chunkMessage(descriptor, nextSequence, offset, transfer));
            outstanding.push(nextSequence);
            nextSequence += 1;
            offset += bytes.byteLength;
        }
        while (outstanding.length > 0) {
            await waitForNextAck();
        }
        if (offset !== descriptor.sourceSizeBytes ||
            `sha256:${hash.digest('hex')}` !== descriptor.sourceSha256 ||
            !(await sourceLease.validate())) {
            terminalReason = 'source_mutated';
            throw new Error('source_stream_mutated');
        }
        port.postMessage(endMessage(descriptor, nextSequence));
        if (!binding.markReady())
            throw new Error('source_stream_terminal');
        port.removeAllListeners();
        await sourceLease.release();
        port.close();
        return { ok: true, value: null };
    }
    catch {
        const reason = terminalReason ?? (controller.signal.aborted ? 'cancelled' : 'source_mutated');
        postAbort(reason);
        await binding.terminate();
        return reason === 'source_mutated'
            ? failure('source_mutated', 'PPTX core source changed while streaming')
            : failure('cancelled', 'PPTX core source stream was cancelled');
    }
}
