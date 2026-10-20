import { BrowserWindow, ipcMain } from "electron";
import { isDev } from "../config/index.js";
import { DEV_SERVER_URL, IPC_CHANNELS } from "../config/constants.js";
import { getEmbeddedBrowserManager } from "../modules/browser/embedded-browser-manager.js";
import { MiniAppComposerBroker } from "../modules/browser/miniapp-composer.js";
import { getUserInfo } from "./storage.ipc.js";
/** The sender is the Host window's own main frame on the Archon page (also used by Agent IPC). */
export function trustedHost(event) {
    if (event.sender.isDestroyed() ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame)
        return false;
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || owner.webContents !== event.sender)
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
export function setupMiniAppComposerIPC() {
    const broker = new MiniAppComposerBroker({
        manager: getEmbeddedBrowserManager(),
        getAccountId: () => {
            const id = getUserInfo().realUserID;
            return typeof id === 'string' && id.trim() ? id : null;
        },
        send: (frame, request) => frame.send(IPC_CHANNELS.MINIAPP_COMPOSER_REQUEST, request),
    });
    const reply = (event, value) => {
        if (trustedHost(event))
            broker.reply(event, value);
    };
    ipcMain.on(IPC_CHANNELS.MINIAPP_COMPOSER_REPLY, reply);
    ipcMain.handle(IPC_CHANNELS.MINIAPP_COMPOSER_APPEND, (event, value) => broker.append(event, value));
    return () => {
        broker.dispose();
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_COMPOSER_REPLY, reply);
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_COMPOSER_APPEND);
    };
}
