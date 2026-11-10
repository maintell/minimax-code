import { registerLocalAsset } from '../../../infra/file/assets-store.js';
import { logger } from '../../../infra/logging/logger.js';
const COVER_DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_COVER_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
class CoverDownloadError extends Error {
    type;
    constructor(type) {
        super(type);
        this.type = type;
    }
}
export async function materializeWebsiteCover(input) {
    if (!input.screenshotUrl)
        return undefined;
    if (!input.nodeId) {
        logCoverStage('cover_store', 'failed', { error_type: 'missing_node_id', latency_ms: 0 });
        return undefined;
    }
    if (!input.dataDir) {
        logCoverStage('cover_store', 'failed', {
            node_id: input.nodeId,
            error_type: 'asset_store_unavailable',
            latency_ms: 0,
        });
        return undefined;
    }
    let png;
    const downloadStartedAt = Date.now();
    try {
        png = await downloadPngCover(input.screenshotUrl, input.fetchImpl, input.signal);
        logCoverStage('cover_download', 'ok', {
            node_id: input.nodeId,
            bytes: png.byteLength,
            latency_ms: Date.now() - downloadStartedAt,
        });
    }
    catch (error) {
        // Never log the thrown message: it can embed a signed screenshot URL or a local path.
        logCoverStage('cover_download', 'failed', {
            node_id: input.nodeId,
            error_type: error instanceof CoverDownloadError ? error.type : 'request_failed',
            latency_ms: Date.now() - downloadStartedAt,
        });
        return undefined;
    }
    const storeStartedAt = Date.now();
    try {
        const asset = await registerLocalAsset({
            dataDir: input.dataDir,
            fileName: `website-cover-${input.nodeId}.png`,
            mimeType: 'image/png',
            kind: 'image',
            sourceKind: 'generated',
            generatedBy: 'website_deploy',
            sessionId: input.sessionId,
            ...(input.turnId ? { turnId: input.turnId } : {}),
            dataUrl: `data:image/png;base64,${png.toString('base64')}`,
            maxBytes: MAX_COVER_BYTES,
        });
        logCoverStage('cover_store', 'ok', {
            node_id: input.nodeId,
            bytes: png.byteLength,
            latency_ms: Date.now() - storeStartedAt,
        });
        return asset.absolutePath;
    }
    catch {
        // Never log the thrown message: it can embed a signed screenshot URL or a local path.
        logCoverStage('cover_store', 'failed', {
            node_id: input.nodeId,
            error_type: 'asset_store_failed',
            latency_ms: Date.now() - storeStartedAt,
        });
        return undefined;
    }
}
async function downloadPngCover(screenshotUrl, fetchImpl, signal) {
    const parsed = parseCoverUrl(screenshotUrl);
    if (!parsed)
        throw new CoverDownloadError('invalid_url');
    if (signal?.aborted)
        throw new CoverDownloadError('aborted');
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, COVER_DOWNLOAD_TIMEOUT_MS);
    const abortFromTurn = () => controller.abort();
    signal?.addEventListener('abort', abortFromTurn, { once: true });
    let reader;
    try {
        // Reject redirects so a trusted HTTPS response cannot bounce into an untrusted scheme.
        const response = await fetchImpl(parsed.toString(), {
            signal: controller.signal,
            credentials: 'omit',
            redirect: 'error',
        });
        reader = readCoverResponse(response);
        return await readPngCover(reader);
    }
    catch (error) {
        if (error instanceof CoverDownloadError)
            throw error;
        if (timedOut)
            throw new CoverDownloadError('timeout');
        if (signal?.aborted)
            throw new CoverDownloadError('aborted');
        throw new CoverDownloadError('request_failed');
    }
    finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromTurn);
        reader?.releaseLock();
    }
}
function parseCoverUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname ? url : undefined;
    }
    catch {
        return undefined;
    }
}
function readCoverResponse(response) {
    if (!response.ok)
        throw new CoverDownloadError('response_status');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'image/png' && contentType !== 'application/octet-stream') {
        throw new CoverDownloadError('content_type');
    }
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_COVER_BYTES) {
        throw new CoverDownloadError('too_large');
    }
    if (!response.body)
        throw new CoverDownloadError('missing_body');
    return response.body.getReader();
}
async function readPngCover(reader) {
    const chunks = [];
    let bytes = 0;
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done)
            break;
        const next = Buffer.from(chunk.value);
        bytes += next.byteLength;
        if (bytes > MAX_COVER_BYTES) {
            try {
                await reader.cancel();
            }
            catch {
                // Cancellation is best-effort; preserve the original size-limit failure.
            }
            throw new CoverDownloadError('too_large');
        }
        chunks.push(next);
    }
    const png = Buffer.concat(chunks, bytes);
    if (png.byteLength < PNG_SIGNATURE.byteLength || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new CoverDownloadError('invalid_png');
    }
    return png;
}
function logCoverStage(stage, result, fields) {
    // Keep this structured log deliberately URL/path-free: screenshot URLs are signed and
    // registerLocalAsset returns an absolute local path.
    logger.info({ stage, result, ...fields }, 'website deploy cover');
}
//# sourceMappingURL=cover-materializer.js.map