import path from "node:path";
import { Worker } from "node:worker_threads";
import { PPTX_PREVIEW_LIMITS_V1, assertPreviewErrorV1, assertPreviewReadSourceValueV1 } from "@mavis/shared/document-preview";
import { noopDocumentPreviewLogger, describeDocumentPreviewError } from "./logging";
const MAX_INPUT_BYTES = PPTX_PREVIEW_LIMITS_V1.maxInputBytes;
const SANITIZER_TIMEOUT_MS = PPTX_PREVIEW_LIMITS_V1.preflightTimeoutMs;
function failure(code, message, retryable = false) {
    return {
        ok: false,
        error: { schema: 'mavis.preview_error.v1', code, message, retryable },
    };
}
function isWorkerResult(value) {
    try {
        if (!value || typeof value !== 'object')
            return false;
        const result = value;
        if (result.ok === false) {
            assertPreviewErrorV1(result.error);
            return true;
        }
        if (result.ok !== true)
            return false;
        assertPreviewReadSourceValueV1(result.value);
        return true;
    }
    catch {
        return false;
    }
}
export function sanitizeOoxmlForPreview(bytes, signal, options = {}, logger = noopDocumentPreviewLogger) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT_BYTES) {
        return Promise.resolve(failure('resource_limit_exceeded', 'OOXML input exceeds the compressed byte limit'));
    }
    if (signal.aborted)
        return Promise.resolve(failure('cancelled', 'OOXML sanitization was cancelled'));
    return new Promise((resolve) => {
        let worker;
        try {
            worker = new Worker(path.join(__dirname, 'ooxml-sanitizer.worker.js'));
        }
        catch {
            resolve(failure('internal', 'OOXML sanitizer worker could not be started', true));
            return;
        }
        let settled = false;
        let timeout;
        const handleMessage = (value) => {
            finish(isWorkerResult(value)
                ? value
                : failure('internal', 'OOXML sanitizer returned an invalid result', true));
        };
        const handleError = (error) => {
            // The rich worker error stays in the main-process log; the renderer only
            // ever receives the stable redacted failure below.
            logger.error({
                msg: '[DocumentPreview][ooxml-sanitizer] worker emitted an error before returning a result',
                ...describeDocumentPreviewError(error),
            });
            finish(failure('internal', 'OOXML sanitizer worker failed', true));
        };
        const handleExit = (code) => {
            logger.error({
                msg: '[DocumentPreview][ooxml-sanitizer] worker exited before returning a result',
                exitCode: typeof code === 'number' ? code : null,
            });
            finish(failure('internal', 'OOXML sanitizer worker stopped unexpectedly', true));
        };
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            if (timeout !== undefined)
                clearTimeout(timeout);
            signal.removeEventListener('abort', handleAbort);
            worker.removeListener('message', handleMessage);
            worker.removeListener('error', handleError);
            worker.removeListener('exit', handleExit);
            void worker.terminate().catch(() => undefined);
            resolve(result);
        };
        const handleAbort = () => finish(failure('cancelled', 'OOXML sanitization was cancelled'));
        timeout = setTimeout(() => finish(failure('timeout', 'OOXML sanitization exceeded the 30 second limit', true)), SANITIZER_TIMEOUT_MS);
        signal.addEventListener('abort', handleAbort, { once: true });
        worker.once('message', handleMessage);
        worker.once('error', handleError);
        worker.once('exit', handleExit);
        const owned = new Uint8Array(bytes.byteLength);
        owned.set(bytes);
        try {
            worker.postMessage({ bytes: owned, options: { pptxPreflight: options.pptxPreflight === true } }, [owned.buffer]);
        }
        catch {
            finish(failure('internal', 'OOXML sanitizer worker input could not be transferred', true));
        }
    });
}
