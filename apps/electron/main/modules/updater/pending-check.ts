import { autoUpdater } from "electron-updater";
import { ensurePublicReleaseFeed } from "./config";
let pendingUpdateCheck = false;
let inFlightProbe = null;
let inFlightCheck = null;
/** 元数据检查期间保留已下载版本的状态和原生安装就绪标记。 */
export function isPendingUpdateCheck() {
    return pendingUpdateCheck;
}
/**
 * 等正在进行的元数据探测结束；没有探测时立即返回。
 *
 * electron-updater 在已有检查进行时会让 `checkForUpdates()` 返回同一个 promise，
 * 而探测期间发出的结果事件会被事件层丢掉。用户或后台检查撞上探测时直接发起检查，
 * 读到的状态会永远停在 `checking`，之后所有检查都直接返回 `checking`。所以这两条
 * 路径必须先等这次探测结束，再自己发起一次新的检查。
 */
export async function waitForPendingUpdateCheck() {
    if (inFlightProbe)
        await inFlightProbe;
}
/**
 * 只检查远端元数据，调用方比较待安装版本后再决定是否下载。
 *
 * 已有探测在进行时直接共享它的结果。再走一遍保存/还原会把 `autoDownload` 还原成
 * 探测期间读到的 `false`，先结束的那次还会清掉后结束那次的 `inFlightProbe`，让
 * `waitForPendingUpdateCheck` 提前返回。
 */
export async function checkPendingUpdate() {
    if (inFlightCheck)
        return await inFlightCheck;
    const autoDownload = autoUpdater.autoDownload;
    pendingUpdateCheck = true;
    autoUpdater.autoDownload = false;
    try {
        // 公开包的 feed 由 release feed 解析结果决定，检查前必须就位。
        await ensurePublicReleaseFeed();
        const probe = autoUpdater.checkForUpdates();
        // 记录这次探测，供并发的用户/后台检查等待。吞掉 rejection：等待方只关心探测
        // 结束，失败原因由 checkPendingUpdate 自己抛给它的调用方。
        inFlightProbe = probe.then(() => undefined, () => undefined);
        inFlightCheck = probe;
        return await probe;
    }
    finally {
        autoUpdater.autoDownload = autoDownload;
        pendingUpdateCheck = false;
        inFlightProbe = null;
        inFlightCheck = null;
    }
}
