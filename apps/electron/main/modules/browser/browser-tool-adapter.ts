import { realpath, stat } from "node:fs/promises";
import { ELECTRON_BROWSER_PUBLIC_ACTIONS } from "./electron-browser-route-policy";
const MAX_BROWSER_UPLOAD_TOTAL_BYTES = 512 * 1024 * 1024;
async function loadManager() {
    const { getEmbeddedBrowserManager } = await import('./embedded-browser-manager');
    return getEmbeddedBrowserManager();
}
export function buildEmbeddedBrowserToolAdapter(options = {}) {
    const getManager = options.getManager ?? loadManager;
    const isEnabled = options.isEnabled ?? (() => true);
    const realpathFile = options.realpathFile ?? realpath;
    const statFile = options.statFile ?? stat;
    return {
        getCapabilities: () => ({
            provider: 'electron-file-panel',
            version: 1,
            actions: ELECTRON_BROWSER_PUBLIC_ACTIONS,
            interactiveTakeover: true,
        }),
        async execute(ctx, action, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            if (!isEnabled())
                throw new Error('FilePanel Browser is not enabled');
            const sessionId = ctx.sessionId.trim();
            if (!sessionId)
                throw new Error('Browser tool requires an active session');
            const { sessionId: _ignoredSessionId, tabId: _ignoredTabId, ...scopedInput } = input;
            const trustedInput = action === 'upload_files'
                ? await resolveAuthorizedUploadInput(ctx, scopedInput, realpathFile, statFile)
                : scopedInput;
            const manager = await getManager();
            if (signal?.aborted)
                throw new Error('Operation aborted');
            try {
                return await manager.executeAgentTool(sessionId, action, trustedInput, signal);
            }
            finally {
                try {
                    options.onAgentAction?.({ sessionId, action });
                }
                catch {
                    // Panel reveal is best-effort and must never replace the Browser
                    // action's successful result or original failure.
                }
            }
        },
    };
}
function resolveAuthorizedUploadInput(ctx, input, realpathFile, statFile) {
    const requestedPaths = Array.isArray(input.paths) ? input.paths : [];
    const authorized = new Map((ctx.browserAssets ?? []).map((asset) => [asset.filePath, asset]));
    return Promise.all(requestedPaths.map(async (requested) => {
        const asset = typeof requested === 'string' ? authorized.get(requested) : undefined;
        if (!asset)
            throw new Error('FILE_NOT_AUTHORIZED: upload path was not authorized by local-runtime');
        const currentRealPath = await realpathFile(asset.filePath).catch(() => null);
        if (currentRealPath !== asset.filePath) {
            throw new Error('FILE_NOT_AUTHORIZED: upload path changed after local-runtime authorization');
        }
        const info = await statFile(asset.filePath).catch(() => null);
        if (!info?.isFile() || !Number.isFinite(info.size) || info.size < 0) {
            throw new Error('FILE_NOT_AUTHORIZED: attachment file is unavailable');
        }
        return {
            filePath: asset.filePath,
            fileName: asset.fileName,
            mimeType: asset.mimeType,
            size: info.size,
        };
    })).then((files) => {
        const totalBytes = files.reduce((total, file) => total + file.size, 0);
        if (totalBytes > MAX_BROWSER_UPLOAD_TOTAL_BYTES) {
            throw new Error('FILE_TOO_LARGE: Browser upload exceeds the current-turn size limit');
        }
        const { paths: _paths, ...rest } = input;
        return {
            ...rest,
            files: files.map(({ size: _size, ...file }) => file),
        };
    });
}
