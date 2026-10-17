import { createHash } from 'node:crypto';
const MAX_POST_ACTION_VISUAL_DEDUP_SESSIONS = 128;
const EXPLICIT_SCREENSHOT_BUDGET = {
    maxBytes: 5 * 1024 * 1024,
    maxEdgePx: 1_920,
};
const POST_ACTION_SCREENSHOT_BUDGET = {
    maxBytes: 1024 * 1024,
    maxEdgePx: 1_280,
};
export function createBrowserScreenshotPreprocessor(options) {
    const lastPostActionFingerprintBySession = new Map();
    const preprocess = async (result, ctx, signal, preprocessOptions) => {
        throwIfAborted(signal);
        const screenshot = readScreenshot(result);
        if (!screenshot)
            return result;
        const budget = preprocessOptions?.purpose === 'post-action'
            ? POST_ACTION_SCREENSHOT_BUDGET
            : EXPLICIT_SCREENSHOT_BUDGET;
        const prepared = prepareScreenshot(options.compressScreenshot, screenshot, budget);
        throwIfAborted(signal);
        if (preprocessOptions?.purpose === 'post-action') {
            return preprocessPostActionScreenshot(prepared, ctx.sessionId, lastPostActionFingerprintBySession);
        }
        return registerExplicitScreenshot(prepared, ctx, options.registerGeneratedAsset, signal);
    };
    return Object.assign(preprocess, {
        clearSession: (sessionId) => lastPostActionFingerprintBySession.delete(sessionId),
        clear: () => lastPostActionFingerprintBySession.clear(),
    });
}
function readScreenshot(result) {
    if (typeof result !== 'object' || result === null || Array.isArray(result))
        return undefined;
    const screenshot = result;
    return typeof screenshot.data === 'string' && screenshot.data.length > 0 ? screenshot : undefined;
}
function prepareScreenshot(compressScreenshot, screenshot, budget) {
    let compressed;
    try {
        compressed = compressScreenshot({
            bytes: Buffer.from(screenshot.data, 'base64'),
            fileName: 'browser-screenshot.png',
            budget,
        });
    }
    catch {
        compressed = undefined;
    }
    const decoded = compressed ? decodeDataUrl(compressed.dataUrl) : undefined;
    if (!compressed || !decoded) {
        throw new Error('BROWSER_SCREENSHOT_PREPROCESS_FAILED: Browser screenshot could not be compressed');
    }
    return {
        compressed,
        decoded,
        result: {
            ...screenshot,
            format: 'jpeg',
            width: compressed.width,
            height: compressed.height,
            bytes: decoded.byteLength,
            data: decoded.toString('base64'),
            visualBudget: budget,
        },
    };
}
function preprocessPostActionScreenshot(prepared, sessionId, fingerprints) {
    const fingerprint = createHash('sha256').update(prepared.decoded).digest('hex');
    if (fingerprints.get(sessionId) === fingerprint) {
        const metadata = { ...prepared.result };
        delete metadata.data;
        return { ...metadata, deduplicated: true };
    }
    fingerprints.set(sessionId, fingerprint);
    trimOldestEntries(fingerprints);
    return prepared.result;
}
async function registerExplicitScreenshot(prepared, ctx, registerGeneratedAsset, signal) {
    try {
        const asset = await registerGeneratedAsset({
            fileName: 'browser-screenshot.jpg',
            mimeType: 'image/jpeg',
            kind: 'image',
            sourceKind: 'generated',
            dataUrl: prepared.compressed.dataUrl,
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            generatedBy: 'browser_screenshot',
        });
        throwIfAborted(signal);
        return {
            ...prepared.result,
            userDelivery: {
                available: true,
                requiresExplicitUserRequest: true,
                assetId: asset.assetId,
                filePath: asset.absolutePath,
                fileName: asset.fileName,
                mimeType: asset.mimeType,
                bytes: asset.bytes,
                mediaMarkup: `<media src="${escapeMediaAttribute(asset.absolutePath)}" caption="Browser screenshot" />`,
            },
        };
    }
    catch (error) {
        if (signal?.aborted)
            throw error;
        return {
            ...prepared.result,
            userDelivery: {
                available: false,
                requiresExplicitUserRequest: true,
                code: 'SCREENSHOT_ASSET_WRITE_FAILED',
            },
        };
    }
}
function decodeDataUrl(dataUrl) {
    const match = /^data:[^;,]*(?:;charset=[^;,]+)?;base64,(.+)$/s.exec(dataUrl);
    if (!match?.[1])
        return undefined;
    return Buffer.from(match[1], 'base64');
}
function trimOldestEntries(values) {
    while (values.size > MAX_POST_ACTION_VISUAL_DEDUP_SESSIONS) {
        const oldest = values.keys().next().value;
        if (typeof oldest !== 'string')
            return;
        values.delete(oldest);
    }
}
function escapeMediaAttribute(value) {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error('Operation aborted');
}
//# sourceMappingURL=screenshot-preprocessor.js.map