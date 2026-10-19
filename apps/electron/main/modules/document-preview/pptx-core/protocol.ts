import { PPTX_CORE_STREAM_CHUNK_BYTES_V1, PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1, PPTX_CORE_STREAM_SCHEMA_V1, decodePptxCoreStreamWorkerMessageV1 } from "@mavis/shared/pptx-rendering";
export { PPTX_CORE_STREAM_CHUNK_BYTES_V1 };
export { PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1 };
export { PPTX_CORE_STREAM_SCHEMA_V1 };
export let PPTX_CORE_RUNTIME_TERMINAL_DIAGNOSTIC_CODE_V1 = 'PPTX-S10-RUNTIME-ASSET-INTEGRITY';
export function pptxCoreRuntimeTerminalResponseV1(error) {
    return Object.freeze({
        error,
        diagnosticCode: PPTX_CORE_RUNTIME_TERMINAL_DIAGNOSTIC_CODE_V1,
        disposition: 'deck-terminal',
    });
}
export function helloMessage(descriptor) {
    return {
        schema: PPTX_CORE_STREAM_SCHEMA_V1,
        kind: 'hello',
        coreSessionId: descriptor.coreSessionId,
        nonce: descriptor.nonce,
        sequence: 0,
        sourceGeneration: descriptor.sourceGeneration,
        sourceSha256: descriptor.sourceSha256,
        sourceSizeBytes: descriptor.sourceSizeBytes,
        chunkBytes: PPTX_CORE_STREAM_CHUNK_BYTES_V1,
        maxUnacknowledged: PPTX_CORE_STREAM_MAX_UNACKNOWLEDGED_V1,
        limitsVersion: descriptor.limitsVersion,
    };
}
export function chunkMessage(descriptor, sequence, offset, bytes) {
    return {
        schema: PPTX_CORE_STREAM_SCHEMA_V1,
        kind: 'chunk',
        coreSessionId: descriptor.coreSessionId,
        nonce: descriptor.nonce,
        sequence,
        offset,
        bytes,
    };
}
export function endMessage(descriptor, sequence) {
    return {
        schema: PPTX_CORE_STREAM_SCHEMA_V1,
        kind: 'end',
        coreSessionId: descriptor.coreSessionId,
        nonce: descriptor.nonce,
        sequence,
        totalBytes: descriptor.sourceSizeBytes,
        sourceSha256: descriptor.sourceSha256,
    };
}
export function abortMessage(descriptor, sequence, reason) {
    return {
        schema: PPTX_CORE_STREAM_SCHEMA_V1,
        kind: 'abort',
        coreSessionId: descriptor.coreSessionId,
        nonce: descriptor.nonce,
        sequence,
        reason,
    };
}
export function decodeBoundWorkerMessage(value, descriptor) {
    const message = decodePptxCoreStreamWorkerMessageV1(value);
    if (message.coreSessionId !== descriptor.coreSessionId || message.nonce !== descriptor.nonce) {
        throw new TypeError('PPTX core stream capability does not match the bound session');
    }
    return message;
}
export function isAckMessage(value) {
    return value.kind === 'ack';
}
