import { OFFSCREEN_BOUNDS } from "./embedded-browser-manager-helpers";
const pendingInitialNavigations = new Map();
export function createNewEmbeddedBrowserTab(manager, bounds, sessionId, options) {
    const initialUrl = options.initialUrl && options.initialUrl !== 'about:blank' ? options.initialUrl : null;
    const pendingKey = initialUrl === null ? null : `${sessionId ?? ''}\u0000${initialUrl}`;
    const pending = pendingKey === null ? undefined : pendingInitialNavigations.get(pendingKey);
    if (pending)
        return pending;
    const creation = createNewEmbeddedBrowserTabOnce(manager, bounds, sessionId, options, initialUrl);
    if (pendingKey !== null) {
        pendingInitialNavigations.set(pendingKey, creation);
        const clearPending = () => {
            if (pendingInitialNavigations.get(pendingKey) === creation) {
                pendingInitialNavigations.delete(pendingKey);
            }
        };
        void creation.then(clearPending, clearPending);
    }
    return creation;
}
async function createNewEmbeddedBrowserTabOnce(manager, bounds, sessionId, options, initialUrl) {
    // Cmd/Ctrl+T must create a fresh logical tab without changing createOrShow's
    // restore-and-reuse contract. Keep that explicit lifecycle orchestration at
    // the IPC boundary until the oversized manager is split into public services.
    // Native/global selection is committed by show() only after the staged
    // handoff succeeds. The legacy visible:false blank-tab shortcut still needs
    // the new logical tab selected within its session so its address-focus
    // request can resolve before the FilePanel mounts.
    const tab = await manager.openTab({
        active: false,
        bounds: OFFSCREEN_BOUNDS,
        ...(initialUrl ? { requestedUrl: initialUrl } : {}),
        selectInSession: !options.visible && initialUrl === null,
        sessionId,
    });
    const target = { tabId: tab.tabId, sessionId };
    try {
        if (initialUrl !== null) {
            await manager.navigate(initialUrl, target);
        }
        if (options.visible) {
            const shown = await manager.show(bounds, target, options.viewport, options.layoutContext);
            if (shown.success === false)
                return shown;
        }
        const state = manager.getState(target);
        const tabs = Array.isArray(state.tabs) ? state.tabs : [];
        const summary = tabs.find((candidate) => Boolean(candidate) &&
            typeof candidate === 'object' &&
            candidate.tabId === tab.tabId);
        return summary ?? { success: true, tabId: tab.tabId };
    }
    catch (error) {
        manager.destroy(tab.tabId);
        throw error;
    }
}
