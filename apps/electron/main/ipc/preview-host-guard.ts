import { BrowserWindow } from "electron";
import { isDev } from "../config";
import { DEV_SERVER_URL } from "../config/constants";
export function trustedPreviewHost(event) {
    if (event.sender.isDestroyed() ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame)
        return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents.id !== event.sender.id)
        return false;
    try {
        const url = new URL(event.sender.getURL());
        if (url.pathname !== '/archon' && url.pathname !== '/archon/')
            return false;
        return isDev
            ? url.origin === new URL(DEV_SERVER_URL).origin
            : url.protocol === 'app:' && url.hostname === '.';
    }
    catch {
        return false;
    }
}
export function validPreviewTarget(value) {
    if (!value || typeof value !== 'object')
        return false;
    const raw = value;
    return (typeof raw.sessionId === 'string' &&
        raw.sessionId.length > 0 &&
        raw.sessionId.length <= 256 &&
        typeof raw.tabId === 'number' &&
        Number.isSafeInteger(raw.tabId) &&
        raw.tabId > 0);
}
export function validPreviewBounds(bounds) {
    if (!bounds || typeof bounds !== 'object')
        return false;
    const rect = bounds;
    return ['x', 'y', 'width', 'height'].every((key) => {
        const value = rect[key];
        return (typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= (key === 'width' || key === 'height' ? 1 : 0) &&
            value <= 30000);
    });
}
