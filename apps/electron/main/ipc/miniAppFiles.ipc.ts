import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants.js";
import { getMiniAppFileOpenBroker } from "../modules/browser/miniapp-file-open.js";
/** Page identities come from Electron; the broker refuses senders that are not managed Mini App pages. */
export function setupMiniAppFilesIPC() {
    const broker = getMiniAppFileOpenBroker();
    const unsubscribe = (event) => broker.unsubscribe(event);
    ipcMain.handle(IPC_CHANNELS.MINIAPP_FILES_SUBSCRIBE, (event) => broker.subscribe(event));
    ipcMain.on(IPC_CHANNELS.MINIAPP_FILES_UNSUBSCRIBE, unsubscribe);
    return () => {
        ipcMain.removeHandler(IPC_CHANNELS.MINIAPP_FILES_SUBSCRIBE);
        ipcMain.removeListener(IPC_CHANNELS.MINIAPP_FILES_UNSUBSCRIBE, unsubscribe);
        broker.dispose();
    };
}
