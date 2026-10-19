/**
 * autoUpdater 事件监听
 *
 * 所有 UI 反馈都通过 IPC 发送给渲染进程，由 React UI 处理
 */
import { autoUpdater } from "electron-updater";
import { BrowserWindow, autoUpdater as electronAutoUpdater } from "electron";
import { IPC_CHANNELS } from "../../config/constants";
import { getCategoryLogger } from "../../utils/logger";
const logger = getCategoryLogger('update');
import { windowManager } from "../../windows/manager";
import { isAutoUpdateEnabled, isNativeUpdateReady, setUpdateStatus, setCachedUpdateInfo, setNativeUpdateReady, setCachedProgress, markUpdateDownloaded, resetTempFlags, getRetryCount, getMaxRetryCount, incrementRetryCount, resetRetryCount } from "./state";
import { isPendingUpdateCheck } from "./pending-check";
import { triggerNativeUpdaterFetch, settleNativeUpdaterFetch } from "./native-fetch";
/**
 * Prime the macOS Squirrel.Mac native update right after the electron-updater
 * zip finishes downloading.
 *
 * With `autoInstallOnAppQuit=false`, Squirrel only fetches the downloaded zip
 * (and emits the native `update-downloaded` that flips `nativeUpdateReady`)
 * when explicitly asked. The normal-quit install path is synchronous and
 * cannot wait for that fetch during shutdown, so without priming it would
 * `exit(0)` and silently skip the pending install forever. Kicking off the
 * fetch here lets `nativeUpdateReady` become true well before the user quits.
 *
 * No-op off darwin, when auto-update is disabled, or when already ready.
 */
function primeNativeUpdateAfterDownload() {
    if (process.platform !== 'darwin')
        return;
    if (!isAutoUpdateEnabled())
        return;
    if (isNativeUpdateReady())
        return;
    logger.info('[Updater] 下载完成，提前触发 Squirrel.Mac 拉取以便退出时可自动安装...');
    const result = triggerNativeUpdaterFetch('download_prime');
    if (!result.success) {
        logger.warn(`[Updater] 预热 Squirrel.Mac 原生更新失败，退出时将回退为普通退出: ${result.error}`);
    }
}
/**
 * 设置 autoUpdater 事件监听
 */
export function setupAutoUpdaterEvents() {
    const sendStatusToRenderer = (event) => {
        // WindowManager's current window (single-tab 'archon' window)
        if (windowManager.isWindowValid()) {
            logger.info(`[Updater] sendStatusToRenderer via window: status=${event.status}`);
            windowManager.sendToWindow(IPC_CHANNELS.UPDATER_STATUS, event);
            return;
        }
        // Last resort: find any non-destroyed BrowserWindow (e.g. during page reload)
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win?.isDestroyed?.() && !win?.webContents?.isDestroyed?.()) {
                logger.info(`[Updater] sendStatusToRenderer via fallback window (id=${win?.id}, title=${win?.getTitle()}): status=${event.status}`);
                win.webContents.send(IPC_CHANNELS.UPDATER_STATUS, event);
                return;
            }
        }
        logger.warn(`[Updater] 无法发送状态到渲染进程: 没有可用的窗口或 Tab`);
    };
    // 检查更新中
    autoUpdater.on('checking-for-update', () => {
        if (isPendingUpdateCheck())
            return;
        logger.info('[Updater] 正在检查更新...');
        setUpdateStatus('checking');
        sendStatusToRenderer({ status: 'checking' });
    });
    // 有可用更新 — 仅通知渲染进程，由用户决定是否下载
    autoUpdater.on('update-available', async (info) => {
        if (isPendingUpdateCheck())
            return;
        logger.info(`[Updater] 发现新版本: ${info.version}`);
        setUpdateStatus('available');
        setCachedUpdateInfo({ version: info.version });
        // 发现新版本意味着即将开始新的下载 → Squirrel.Mac 会重新处理，
        // 之前的 nativeUpdateReady 状态不再可靠，需要重置。
        // 注意：不能在 checking-for-update 重置，因为"已下载 → 手动检查 → 同版本"
        // 的路径不会触发新下载，Squirrel 不会重新处理，native 事件不会再次触发，
        // 此时重置会导致已就绪的更新无法安装（30s 超时）。
        setNativeUpdateReady(false);
        sendStatusToRenderer({
            status: 'available',
            updateInfo: { version: info.version },
        });
    });
    // 没有可用更新
    autoUpdater.on('update-not-available', async () => {
        if (isPendingUpdateCheck())
            return;
        const currentVersion = autoUpdater.currentVersion.version;
        logger.info(`[Updater] 当前已是最新版本: ${currentVersion}`);
        setUpdateStatus('not-available');
        setCachedUpdateInfo({ version: currentVersion });
        sendStatusToRenderer({
            status: 'not-available',
            updateInfo: { version: currentVersion },
        });
    });
    // 下载进度
    autoUpdater.on('download-progress', (progress) => {
        setUpdateStatus('downloading');
        setCachedProgress({
            percent: progress.percent,
            bytesPerSecond: progress.bytesPerSecond,
            transferred: progress.transferred,
            total: progress.total,
            delta: progress.delta,
        });
        const percent = progress.percent;
        const transferred = (progress.transferred / 1024 / 1024).toFixed(1);
        const total = (progress.total / 1024 / 1024).toFixed(1);
        const speed = (progress.bytesPerSecond / 1024 / 1024).toFixed(1);
        logger.info(`[Updater] 下载进度: ${percent.toFixed(1)}% (${transferred}/${total} MB, ${speed} MB/s)`);
        sendStatusToRenderer({
            status: 'downloading',
            updateInfo: { progress },
        });
    });
    // 下载完成
    autoUpdater.on('update-downloaded', async (info) => {
        // electron-updater passes UpdateDownloadedEvent which extends UpdateInfo
        // with a `downloadedFile` property containing the absolute path.
        const downloadedFile = info.downloadedFile;
        logger.info(`[Updater] 更新下载完成: ${info.version}, file: ${downloadedFile || 'unknown'}`);
        setUpdateStatus('downloaded');
        markUpdateDownloaded(downloadedFile);
        setCachedUpdateInfo({ version: info.version });
        setCachedProgress(null);
        sendStatusToRenderer({
            status: 'downloaded',
            updateInfo: { version: info.version },
        });
        resetTempFlags();
        // Kick off the Squirrel.Mac native fetch now so a plain quit can auto-install
        // instead of silently skipping (autoInstallOnAppQuit is disabled).
        primeNativeUpdateAfterDownload();
    });
    // 更新错误
    autoUpdater.on('error', async (error) => {
        if (isPendingUpdateCheck())
            return;
        logger.error(`[Updater] 更新错误: ${error.message}`);
        // 检查是否是 HTTP/2 协议错误，如果是则自动重试
        const isHttp2Error = error.message.includes('ERR_HTTP2_PROTOCOL_ERROR') ||
            error.message.includes('ERR_HTTP2') ||
            error.message.includes('PROTOCOL_ERROR');
        if (isHttp2Error && getRetryCount() < getMaxRetryCount()) {
            const count = incrementRetryCount();
            logger.info(`[Updater] 检测到 HTTP/2 错误，正在重试... (${count}/${getMaxRetryCount()})`);
            // 等待一段时间后重试
            await new Promise((resolve) => setTimeout(resolve, 2000 * count));
            try {
                await autoUpdater.checkForUpdates();
                return; // 重试成功，不发送错误
            }
            catch (retryError) {
                logger.error(`[Updater] 重试失败: ${retryError}`);
            }
        }
        // 重置重试计数
        resetRetryCount();
        // 发送错误状态给渲染进程
        setUpdateStatus('error');
        sendStatusToRenderer({ status: 'error', error: error.message });
        resetTempFlags();
    });
    // macOS: 监听 Squirrel.Mac 原生 update-downloaded 事件。
    // electron-updater 内部通过 electron.autoUpdater（即 Squirrel.Mac）来完成
    // 更新的解压/应用，只有这个原生事件触发后 quitAndInstall 才能安全调用。
    if (process.platform === 'darwin') {
        electronAutoUpdater.on('update-downloaded', () => {
            logger.info('[Updater] Squirrel.Mac 原生更新就绪 (nativeUpdater.update-downloaded)');
            settleNativeUpdaterFetch('ready');
            setNativeUpdateReady(true);
        });
        electronAutoUpdater.on('update-not-available', () => {
            logger.warn('[Updater] Squirrel.Mac 未发现可用原生更新，允许后续重新拉取');
            settleNativeUpdaterFetch('not_available');
        });
        electronAutoUpdater.on('error', (error) => {
            logger.warn(`[Updater] Squirrel.Mac 原生更新拉取失败，允许后续重试: ${error.message}`);
            settleNativeUpdaterFetch('error');
        });
    }
}
