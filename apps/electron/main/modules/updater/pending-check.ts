import { autoUpdater } from "electron-updater";
import { ensurePublicReleaseFeed } from "./config";
let pendingUpdateCheck = false;
/** 元数据检查期间保留已下载版本的状态和原生安装就绪标记。 */
export function isPendingUpdateCheck() {
    return pendingUpdateCheck;
}
/** 只检查远端元数据，调用方比较待安装版本后再决定是否下载。 */
export async function checkPendingUpdate() {
    // 公开包的 feed 由 release feed 解析结果决定，检查前必须就位。
    await ensurePublicReleaseFeed();
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
