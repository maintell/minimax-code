import { realpath, stat } from "node:fs/promises";
import { ELECTRON_BROWSER_PUBLIC_ACTIONS } from "./electron-browser-route-policy";
/** Tab-control actions address a tab by the ID that list_tabs returned. */
const TAB_ID_ACTIONS = new Set([
    'select_tab',
    'close_tab',
    'mark_tab',
    'show_tab',
    'release_tab',
]);
/** Program tab ops that open, select, close or show a page; `tabs` and `keep` change nothing on screen. */
const PROGRAM_TAB_CHANGING_OPS = {
    newPage: true,
    selectTab: true,
    closeTab: true,
    show: true,
};
/** Whether a program page op wrote to the page (its step says so, also when its outcome is unknown). */
function programStepWrote(result) {
    if (!result || typeof result !== 'object' || !('step' in result))
        return false;
    const step = result.step;
    return Boolean(step && typeof step === 'object' && 'write' in step && step.write === true);
}
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
            // run_script on a PTC Turn is a Browser program: its page ops come here
            // as `program_op`. On other Turns run_script is the provider's page
            // script (the selected HTTP(S) page or managed Mini App).
            programOps: true,
        }),
        async execute(ctx, action, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            if (!isEnabled())
                throw new Error('FilePanel Browser is not enabled');
            const sessionId = ctx.sessionId.trim();
            if (!sessionId)
                throw new Error('Browser tool requires an active session');
            const program = action === 'program_op';
            const { sessionId: _ignoredSessionId, tabId: requestedTabId, ...rest } = input;
            // Only tab-control actions and program ops take a tab ID; the manager
            // checks it belongs to this session. Every other action targets the
            // controlled tab.
            const scopedInput = (program || TAB_ID_ACTIONS.has(action)) &&
                requestedTabId !== undefined
                ? { ...rest, tabId: requestedTabId }
                : rest;
            const trustedInput = action === 'upload_files'
                ? await resolveAuthorizedUploadInput(ctx, scopedInput, realpathFile, statFile)
                : scopedInput;
            const manager = await getManager();
            if (signal?.aborted)
                throw new Error('Operation aborted');
            let revealedAction = action;
            let revealedPluginId;
            // A program's reads do not refresh the Browser header or reveal the panel.
            let changedBrowser = !program;
            try {
                const turn = {
                    turnId: ctx.turnId,
                    ...(ctx.browserEphemeral ? { ephemeral: true } : {}),
                };
                // show_tab, open_tab { show } and a program's page.show() ask the renderer
                // to put the page on screen. A sub-Agent's Browser is never shown.
                const reveal = ctx.browserEphemeral
                    ? undefined
                    : () => {
                        try {
                            options.onAgentAction?.({ sessionId, action: 'show_tab' });
                        }
                        catch {
                            // Showing is best-effort; the action reports whether it happened.
                        }
                    };
                if (program) {
                    const result = await manager.executeAgentProgramOp(sessionId, trustedInput, signal, {
                        ...turn,
                        ...(reveal ? { reveal } : {}),
                    });
                    changedBrowser =
                        PROGRAM_TAB_CHANGING_OPS[String(trustedInput.op)] === true || programStepWrote(result);
                    return result;
                }
                const result = await manager.executeAgentTool(sessionId, action, trustedInput, signal, {
                    ...turn,
                    ...(reveal ? { reveal } : {}),
                });
                if (action === 'open_tab' &&
                    typeof trustedInput.miniAppId === 'string' &&
                    trustedInput.miniAppId.trim()) {
                    revealedAction = 'open_miniapp';
                    revealedPluginId = trustedInput.miniAppId.trim();
                }
                return result;
            }
            finally {
                try {
                    // A sub-Agent's Browser is never shown to the user.
                    if (!ctx.browserEphemeral && changedBrowser) {
                        options.onAgentAction?.({
                            sessionId,
                            action: revealedAction,
                            ...(revealedPluginId ? { pluginId: revealedPluginId } : {}),
                        });
                    }
                }
                catch {
                    // Header and activity-indicator refresh must not replace the Browser
                    // action's successful result or original failure.
                }
            }
        },
        notifyLifecycle(event) {
            if (!isEnabled())
                return;
            void getManager()
                .then((manager) => manager.handleAgentLifecycle?.(event))
                .catch(() => undefined);
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
