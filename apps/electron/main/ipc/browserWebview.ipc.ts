import { ipcMain } from "electron";
import { WEBVIEW_HOST_CHANNELS, browserGuestRegistry } from "../modules/browser/browser-guest-registry.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
export function setupBrowserWebviewIPC() {
    ipcMain.handle(WEBVIEW_HOST_CHANNELS.ready, (event) => {
        if (!browserGuestRegistry.isTrusted(event))
            throw new Error('BROWSER_WEBVIEW_UNTRUSTED_HOST');
        const snapshot = browserGuestRegistry.ready(event.sender);
        const manager = getEmbeddedBrowserManager();
        void manager.recoverDetachedWebviews(event.sender);
        void manager.recoverInlineWebviews(event.sender);
        return snapshot;
    });
    const applied = (event, id, revision) => {
        if (browserGuestRegistry.isTrusted(event))
            browserGuestRegistry.applied(event.sender, id, revision);
    };
    ipcMain.on(WEBVIEW_HOST_CHANNELS.applied, applied);
    const nativeReady = (event, id, blocked) => {
        if (browserGuestRegistry.isTrusted(event))
            browserGuestRegistry.nativeReady(event.sender, id, blocked);
    };
    ipcMain.on(WEBVIEW_HOST_CHANNELS.nativeReady, nativeReady);
    return () => {
        ipcMain.removeHandler(WEBVIEW_HOST_CHANNELS.ready);
        ipcMain.removeListener(WEBVIEW_HOST_CHANNELS.applied, applied);
        ipcMain.removeListener(WEBVIEW_HOST_CHANNELS.nativeReady, nativeReady);
    };
}
