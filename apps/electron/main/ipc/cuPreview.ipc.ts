import { BrowserWindow, ipcMain } from "electron";
import { isDev } from "../config";
import { DEV_SERVER_URL } from "../config/constants";
import { inspectCuaPreview } from "../modules/local-runtime/computer-use/cua-preview";
function trustedHostRenderer(event) {
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
export function setupCuPreviewIPC() {
    ipcMain.handle('cu:preview:inspect', async (event, sessionId, capture) => {
        if (!trustedHostRenderer(event) ||
            typeof sessionId !== 'string' ||
            sessionId.length > 256 ||
            typeof capture !== 'boolean')
            return null;
        return inspectCuaPreview(sessionId, capture);
    });
}
