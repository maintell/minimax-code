import { getCategoryLogger } from "../../utils/logger";
const logger = getCategoryLogger('update');
// ============================================
// 状态变量
// ============================================
// 检查更新的重试次数
const MAX_RETRY_COUNT = 3;
let retryCount = 0;
// 当前更新状态
let updateStatus = 'idle';
// 缓存的更新信息
let cachedUpdateInfo = null;
// 缓存的下载进度
let cachedProgress = null;
// 标记当前检查是否为用户主动触发
// 用户主动检查时会显示 React UI，启动时自动检查则静默下载
let isUserTriggeredCheck = false;
// 独立的"已下载待安装"标记。
// updateStatus 会被后续定时检查覆盖（checking → not-available / error），
// 但 hasDownloadedUpdate 只在 update-downloaded 事件时设为 true，
// 退出前不会被任何后续检查重置。will-quit handler 用此标记判断是否需要安装。
let hasDownloadedUpdate = false;
// The absolute path to the downloaded installer file.
// Saved on 'update-downloaded' so we can verify it still exists before quitAndInstall.
let downloadedFilePath = null;
// macOS Squirrel.Mac 原生就绪标记。
// electron-updater 的 update-downloaded 事件在 zip 下载完成后就触发，
// 但 Squirrel.Mac 还需要额外时间解压/校验/应用更新。
// 只有原生 nativeUpdater 的 update-downloaded 事件触发后，quitAndInstall 才安全。
// 每次 checkForUpdates 会重新触发 Squirrel 流程，所以 checking-for-update 时重置。
let nativeUpdateReady = false;
// ============================================
// Getter / Setter
// ============================================
export function getRetryCount() {
    return retryCount;
}
export function incrementRetryCount() {
    return ++retryCount;
}
export function resetRetryCount() {
    retryCount = 0;
}
export function getMaxRetryCount() {
    return MAX_RETRY_COUNT;
}
// ============================================
// 更新状态管理
// ============================================
export function getUpdateStatus() {
    return updateStatus;
}
export function setUpdateStatus(status) {
    // 下载进度每次回调都会重复设置 downloading，只记录真正发生的状态变化
    if (status !== updateStatus) {
        logger.info(`[Updater] 状态变更: ${updateStatus} -> ${status}`);
    }
    updateStatus = status;
}
// 便捷方法：检查当前状态
export function isChecking() {
    return updateStatus === 'checking';
}
export function isDownloading() {
    return updateStatus === 'downloading';
}
export function isDownloaded() {
    return updateStatus === 'downloaded';
}
/**
 * Whether an update has been downloaded and is ready to install.
 * Unlike isDownloaded() (which reads updateStatus and can be overwritten by
 * subsequent periodic checks → 'checking' / 'not-available' / 'error'),
 * this flag is set once on 'update-downloaded' and never cleared by checks.
 * Use this in will-quit to decide whether to run the NSIS installer.
 */
export function hasUpdateReady() {
    return hasDownloadedUpdate;
}
/** Mark that an update has been downloaded. Called from events.ts on 'update-downloaded'. */
export function markUpdateDownloaded(filePath) {
    hasDownloadedUpdate = true;
    downloadedFilePath = filePath ?? null;
}
/**
 * Get the path to the downloaded installer file.
 * Used to verify the file still exists before calling quitAndInstall.
 */
export function getDownloadedFilePath() {
    return downloadedFilePath;
}
export function isUpToDate() {
    return updateStatus === 'not-available';
}
// ============================================
// macOS 原生更新就绪状态
// ============================================
/**
 * Whether the native Squirrel.Mac updater has finished applying the update.
 * Only meaningful on macOS; always returns true on other platforms.
 */
export function isNativeUpdateReady() {
    if (process.platform !== 'darwin')
        return true;
    return nativeUpdateReady;
}
export function setNativeUpdateReady(value) {
    logger.info(`[Updater] nativeUpdateReady: ${nativeUpdateReady} -> ${value}`);
    nativeUpdateReady = value;
}
// ============================================
// 缓存信息管理
// ============================================
export function getCachedUpdateInfo() {
    return cachedUpdateInfo;
}
export function setCachedUpdateInfo(info) {
    cachedUpdateInfo = info;
}
export function getCachedProgress() {
    return cachedProgress;
}
export function setCachedProgress(progress) {
    cachedProgress = progress;
}
// ============================================
// 用户触发标记
// ============================================
export function getIsUserTriggeredCheck() {
    return isUserTriggeredCheck;
}
export function setIsUserTriggeredCheck(value) {
    isUserTriggeredCheck = value;
    logger.info(`[Updater] 用户主动触发检查: ${value}`);
}
/**
 * 重置所有临时状态标记
 */
export function resetTempFlags() {
    isUserTriggeredCheck = false;
}
/**
 * 重置更新缓存（用于重新开始下载流程）
 */
export function resetUpdateCache() {
    logger.info('[Updater] 重置更新缓存');
    updateStatus = 'idle';
    cachedUpdateInfo = null;
    cachedProgress = null;
    hasDownloadedUpdate = false;
    downloadedFilePath = null;
    nativeUpdateReady = false;
}
// ============================================
// Apollo 自动安装控制
// ============================================
/**
 * Whether Apollo agentConfig.autoUpdateDesktopVersion is enabled.
 * When true, downloaded updates are silently installed on app quit.
 * When false (default), updates are only installed when the user
 * explicitly clicks "Install Update".
 */
let autoUpdateEnabled = false;
export function isAutoUpdateEnabled() {
    return autoUpdateEnabled;
}
export function setAutoUpdateEnabled(value) {
    autoUpdateEnabled = value;
}
