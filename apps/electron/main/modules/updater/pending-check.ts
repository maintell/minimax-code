import { autoUpdater } from "electron-updater";
let pendingUpdateCheck = false;
/** 元数据检查期间保留已下载版本的状态和原生安装就绪标记。 */
export function isPendingUpdateCheck() {
    return pendingUpdateCheck;
}
/** 只检查远端元数据，调用方比较待安装版本后再决定是否下载。 */
export async function checkPendingUpdate() {
    const autoDownload = autoUpdater.autoDownload;
    pendingUpdateCheck = true;
    autoUpdater.autoDownload = false;
    try {
        return await autoUpdater.checkForUpdates();
    }
    finally {
        autoUpdater.autoDownload = autoDownload;
        pendingUpdateCheck = false;
    }
}
