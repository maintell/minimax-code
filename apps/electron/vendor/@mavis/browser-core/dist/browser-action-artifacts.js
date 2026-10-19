import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { asNumber, asString, cdp, isRecord, } from './browser-state.js';
const DOWNLOAD_DETECTION_TIMEOUT_MS = 500;
// Downloads are provider-owned background work. Keep click latency bounded
// while returning an explicit in-progress observation that prevents a model
// from clicking the download control again.
const DOWNLOAD_COMPLETION_TIMEOUT_MS = 5_000;
const MAX_DOWNLOAD_COMPLETION_TIMEOUT_MS = 120_000;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
export async function captureBrowserScreenshot(session, input, readPageSummary) {
    const scope = asString(input.scope, 'viewport');
    let clip;
    let captureBeyondViewport = false;
    if (scope === 'clip' && isRecord(input.clip)) {
        clip = {
            x: asNumber(input.clip.x),
            y: asNumber(input.clip.y),
            width: Math.max(1, asNumber(input.clip.width)),
            height: Math.max(1, asNumber(input.clip.height)),
            scale: 1,
        };
    }
    else if (scope === 'fullPage') {
        const page = await readPageSummary();
        captureBeyondViewport =
            page.pageWidth > page.viewport.width || page.pageHeight > page.viewport.height;
        if (captureBeyondViewport) {
            clip = {
                x: 0,
                y: 0,
                width: Math.max(1, page.pageWidth),
                height: Math.max(1, page.pageHeight),
                scale: 1,
            };
        }
    }
    let format = 'png';
    let quality;
    let result = await cdp(session, 'Page.captureScreenshot', {
        format,
        captureBeyondViewport,
        ...(clip ? { clip } : {}),
    });
    if (!result.data)
        throw new Error('SCREENSHOT_EMPTY');
    let buffer = Buffer.from(result.data, 'base64');
    if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
        format = 'jpeg';
        quality = 60;
        result = await cdp(session, 'Page.captureScreenshot', {
            format,
            quality,
            captureBeyondViewport,
            ...(clip ? { clip } : {}),
        });
        if (!result.data)
            throw new Error('SCREENSHOT_EMPTY');
        buffer = Buffer.from(result.data, 'base64');
    }
    const fallbackSize = clip ?? (await readPageSummary()).viewport;
    const isPng = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'));
    const width = isPng ? buffer.readUInt32BE(16) : fallbackSize.width;
    const height = isPng ? buffer.readUInt32BE(20) : fallbackSize.height;
    const filePath = asString(input.file_path);
    if (filePath) {
        await mkdir(path.dirname(filePath), { recursive: true }).catch(() => undefined);
        await writeFile(filePath, buffer);
    }
    return {
        success: true,
        format,
        width,
        height,
        bytes: buffer.byteLength,
        ...(buffer.byteLength <= MAX_SCREENSHOT_BYTES ? { data: result.data } : { dataOmitted: true }),
        ...(quality === undefined ? {} : { quality }),
        ...(filePath ? { file_path: filePath } : {}),
    };
}
/** Observe provider-owned download events without touching host clipboard or personal files. */
export function observeBrowserDownload(session, options = {}) {
    if (!session.transport.downloadDirectory)
        return Promise.resolve(undefined);
    return new Promise((resolve) => {
        let observation;
        let finished = false;
        let detectionTimer;
        let completionTimer;
        const requestedCompletionTimeoutMs = typeof options.completionTimeoutMs === 'number' &&
            Number.isFinite(options.completionTimeoutMs) &&
            options.completionTimeoutMs > 0
            ? Math.floor(options.completionTimeoutMs)
            : DOWNLOAD_COMPLETION_TIMEOUT_MS;
        const completionTimeoutMs = Math.max(DOWNLOAD_DETECTION_TIMEOUT_MS, Math.min(MAX_DOWNLOAD_COMPLETION_TIMEOUT_MS, requestedCompletionTimeoutMs));
        detectionTimer = setTimeout(() => finish(observation), DOWNLOAD_DETECTION_TIMEOUT_MS);
        detectionTimer.unref?.();
        const unsubscribe = session.transport.onEvent((event) => {
            if ((event.method === 'Browser.downloadWillBegin' ||
                event.method === 'Page.downloadWillBegin') &&
                isRecord(event.params)) {
                const guid = asString(event.params.guid);
                if (!guid)
                    return;
                const fileName = safeDownloadFileName(asString(event.params.suggestedFilename));
                observation = {
                    guid,
                    state: 'inProgress',
                    url: asString(event.params.url) || undefined,
                    ...(fileName ? { fileName } : {}),
                    ...(fileName && session.transport.downloadDirectory
                        ? { filePath: path.join(session.transport.downloadDirectory, fileName) }
                        : {}),
                };
                if (detectionTimer)
                    clearTimeout(detectionTimer);
                completionTimer = setTimeout(() => finish(observation
                    ? { ...observation, state: 'inProgress', observation: 'timeout' }
                    : undefined), completionTimeoutMs);
                completionTimer.unref?.();
                return;
            }
            if (event.method !== 'Browser.downloadProgress' && event.method !== 'Page.downloadProgress') {
                return;
            }
            if (!isRecord(event.params))
                return;
            const guid = asString(event.params.guid);
            if (!observation || guid !== observation.guid)
                return;
            const state = event.params.state;
            if (state !== 'inProgress' && state !== 'completed' && state !== 'canceled')
                return;
            const receivedBytes = finiteNumber(event.params.receivedBytes);
            const totalBytes = finiteNumber(event.params.totalBytes);
            observation = {
                ...observation,
                state,
                ...(receivedBytes !== undefined ? { receivedBytes } : {}),
                ...(totalBytes !== undefined ? { totalBytes } : {}),
                ...(typeof event.params.filePath === 'string' ? { filePath: event.params.filePath } : {}),
            };
            if (state === 'completed' || state === 'canceled')
                finish(observation);
        });
        function finish(value) {
            if (finished)
                return;
            finished = true;
            if (detectionTimer)
                clearTimeout(detectionTimer);
            if (completionTimer)
                clearTimeout(completionTimer);
            options.signal?.removeEventListener('abort', onAbort);
            unsubscribe();
            resolve(value);
        }
        const onAbort = () => {
            finish(observation);
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted)
            onAbort();
    });
}
function safeDownloadFileName(value) {
    if (!value)
        return undefined;
    const fileName = path.basename(value).trim();
    return fileName && fileName !== '.' && fileName !== '..' ? fileName : undefined;
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
//# sourceMappingURL=browser-action-artifacts.js.map