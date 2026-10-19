/**
 * 自动更新 IPC 处理
 *
 * 具体实现请参考 modules/updater/
 */
import { ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "node:fs";
import { isDev } from "../config/env";
import { IPC_CHANNELS } from "../config/constants";
import { isVersionLower } from "../utils";
import { getCategoryLogger } from "../utils/logger";
import { windowManager } from "../windows/manager";
import { isNativeUpdateReady, hasUpdateReady, isAutoUpdateEnabled, getDownloadedFilePath, resetUpdateCache, setUpdateStatus, getUpdateStatus, getCachedUpdateInfo, setUserTriggeredCheck, getCachedProgress, setAutoUpdateEnabled, initUpdater } from "../modules/updater";
import { isPendingUpdateCheck, checkPendingUpdate } from "../modules/updater/pending-check";
import { triggerNativeUpdaterFetch, isNativeUpdaterFetchInFlight } from "../modules/updater/native-fetch";
const logger = getCategoryLogger('update');
/**
 * 轮询等待 macOS Squirrel.Mac 原生更新就绪。
 * @param timeoutMs 超时时间（毫秒）
 * @returns 是否在超时前就绪
 */
function waitForNativeReady(timeoutMs) {
    if (isNativeUpdateReady())
        return Promise.resolve(true);
    return new Promise((resolve) => {
        const POLL_MS = 300;
        const start = Date.now();
        const timer = setInterval(() => {
            if (isNativeUpdateReady()) {
                clearInterval(timer);
                resolve(true);
            }
            else if (Date.now() - start >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, POLL_MS);
    });
}
/** Resolve the normal application-quit plan without claiming lifecycle ownership. */
export function resolveNormalUpdatePlan() {
    if (!hasUpdateReady() || !isAutoUpdateEnabled())
        return { kind: 'exit', code: 0 };
    const installerPath = getDownloadedFilePath();
    if (installerPath && !fs.existsSync(installerPath)) {
        logger.error(`[Updater] 待安装文件不存在: ${installerPath}，跳过自动安装`);
        return { kind: 'exit', code: 0 };
    }
    // Squirrel.Mac can report `update-downloaded` before its native package is
    // ready. Keep the update pending and perform a normal exit rather than
    // handing an ineligible installer to quitAndInstall during external quit.
    //
    // This path is synchronous (it must not block shutdown), so we cannot wait
    // for the native fetch here. We normally prime the native fetch right after
    // the download completes (see `primeNativeUpdateAfterDownload`), so by the time the
    // user quits `nativeUpdateReady` is usually already true. As a defensive
    // fallback — e.g. auto-update toggled on after the download, or a missed
    // prime — kick off the native fetch now so the *next* quit can install
    // instead of silently skipping forever.
    if (process.platform === 'darwin' && !isNativeUpdateReady()) {
        logger.warn('[Updater] Squirrel.Mac 原生更新尚未就绪，本次延后自动安装并预热下次安装');
        triggerNativeUpdaterFetch('normal_quit');
        return { kind: 'exit', code: 0 };
    }
    return {
        kind: 'install',
        installerPath: installerPath ?? undefined,
        isSilent: true,
        isForceRunAfter: false,
    };
}
/** Validate an explicit install request without invoking a terminal action. */
export async function resolveExplicitInstallPlan() {
    if (isDev)
        return { status: 'invalid', error: new Error('dev mode') };
    if (!hasUpdateReady()) {
        return { status: 'invalid', error: new Error('UPDATE_NOT_READY') };
    }
    const filePath = getDownloadedFilePath();
    if (filePath && !fs.existsSync(filePath)) {
        logger.error(`[Updater] 待安装文件不存在: ${filePath}，触发重新下载`);
        resetUpdateCache();
        setUpdateStatus('error');
        autoUpdater.checkForUpdates().catch((err) => {
            logger.error(`[Updater] 重新检查更新失败: ${err.message}`);
        });
        return { status: 'invalid', error: new Error('INSTALLER_FILE_MISSING') };
    }
    if (process.platform === 'darwin' && !isNativeUpdateReady()) {
        logger.info('[Updater] 触发 Squirrel.Mac 拉取本地更新包...');
        const triggerResult = triggerNativeUpdaterFetch('explicit_install');
        if (!triggerResult.success) {
            return { status: 'invalid', error: new Error(triggerResult.error) };
        }
        logger.info('[Updater] 等待 Squirrel.Mac 原生更新就绪...');
        const ready = await waitForNativeReady(30000);
        if (!ready) {
            logger.error('[Updater] Squirrel.Mac 30s 内未就绪，放弃安装');
            return { status: 'invalid', error: new Error('NATIVE_UPDATER_NOT_READY') };
        }
        logger.info('[Updater] Squirrel.Mac 原生更新已就绪');
    }
    return {
        status: 'valid',
        plan: {
            kind: 'install',
            installerPath: filePath ?? undefined,
            isSilent: false,
            isForceRunAfter: true,
        },
    };
}
/** 设置 IPC 处理器。 */
function setupUpdaterIPCHandlers(options) {
    // 检查更新
    // options.userTriggered: 是否为用户主动触发
    ipcMain.handle(IPC_CHANNELS.UPDATER_CHECK, async (_event, options) => {
        if (isDev) {
            return { success: true, status: 'not-available' };
        }
        const userTriggered = options?.userTriggered ?? true;
        const currentStatus = getUpdateStatus();
        const cachedInfo = getCachedUpdateInfo();
        logger.info(`[Updater] 收到检查更新请求 (userTriggered: ${userTriggered}, ` +
            `status: ${currentStatus}, cachedVersion: ${cachedInfo?.version})`);
        // 统一设置用户触发标记
        setUserTriggeredCheck(userTriggered);
        // 元数据检查不发布临时状态；并发请求直接返回仍可安装的版本。
        if (isPendingUpdateCheck()) {
            return { success: true, status: 'downloaded', updateInfo: cachedInfo || undefined };
        }
        // 1. 如果正在检查中，直接返回（避免重复检查）
        if (currentStatus === 'checking') {
            logger.info('[Updater] 已有检查更新任务在进行中');
            return {
                success: true,
                status: 'checking',
            };
        }
        // 2. 如果发现新版本（即将开始下载），直接返回
        if (currentStatus === 'available') {
            logger.info('[Updater] 已发现新版本，即将开始下载');
            return {
                success: true,
                status: 'available',
                updateInfo: {
                    version: cachedInfo?.version,
                },
            };
        }
        // 3. 如果正在下载中，直接返回当前进度（避免中断下载）
        if (currentStatus === 'downloading') {
            logger.info('[Updater] 更新正在下载中');
            const cachedProgress = getCachedProgress();
            return {
                success: true,
                status: 'downloading',
                updateInfo: {
                    version: cachedInfo?.version,
                    progress: cachedProgress || undefined,
                },
            };
        }
        // 已下载后，手动和后台检查都先比较远端版本；检查本身不覆盖待安装包。
        if (currentStatus === 'downloaded' || hasUpdateReady()) {
            try {
                logger.info('[Updater] 已有待安装版本，检查远端是否有更新');
                const result = await checkPendingUpdate();
                const latestVersion = result?.updateInfo?.version;
                logger.info(`[Updater] 待安装版本检查完成: downloaded=${cachedInfo?.version}, remote=${latestVersion}, ` +
                    `nativeFetchInFlight=${isNativeUpdaterFetchInFlight()}`);
                if (!windowManager.isAppQuitting() &&
                    !isNativeUpdaterFetchInFlight() &&
                    result?.isUpdateAvailable &&
                    latestVersion &&
                    isVersionLower(cachedInfo?.version, latestVersion)) {
                    // 必须在启动下载前清理，避免覆盖快速完成的下载事件。
                    resetUpdateCache();
                    autoUpdater.emit('update-available', result.updateInfo);
                    void autoUpdater.downloadUpdate().catch((error) => {
                        logger.error(`[Updater] 下载更新版本失败: ${error.message}`);
                    });
                    return {
                        success: true,
                        status: getUpdateStatus(),
                        updateInfo: getCachedUpdateInfo() || { version: latestVersion },
                    };
                }
            }
            catch (error) {
                logger.error(`[Updater] 检查更新版本失败，保留待安装版本: ${error}`);
            }
            return {
                success: true,
                status: 'downloaded',
                updateInfo: cachedInfo || undefined,
            };
        }
        if (userTriggered) {
            // 4.2 其他状态，去服务端检查
            try {
                logger.info('[Updater] 用户主动触发，检查服务端最新版本');
                setUpdateStatus('checking');
                const result = await autoUpdater.checkForUpdates();
                // checkForUpdates 完成后，状态已通过事件更新，返回当前最新状态
                const updatedStatus = getUpdateStatus();
                const updatedInfo = getCachedUpdateInfo();
                const updatedProgress = getCachedProgress();
                return {
                    success: true,
                    status: updatedStatus,
                    updateInfo: {
                        version: updatedInfo?.version || result?.updateInfo?.version,
                        progress: updatedProgress || undefined,
                    },
                };
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                logger.error(`[Updater] 检查更新失败: ${errorMessage}`);
                setUpdateStatus('error');
                return {
                    success: false,
                    status: 'error',
                    error: errorMessage,
                };
            }
        }
        // 后台定时检查沿用相同的远端检查流程。
        try {
            logger.info(`[Updater] 静默检查更新 (当前状态: ${currentStatus})`);
            setUpdateStatus('checking');
            await autoUpdater.checkForUpdates();
            const updatedStatus = getUpdateStatus();
            const updatedInfo = getCachedUpdateInfo();
            return {
                success: true,
                status: updatedStatus,
                updateInfo: updatedInfo || undefined,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[Updater] 检查更新失败: ${errorMessage}`);
            setUpdateStatus('error');
            return {
                success: false,
                status: 'error',
                error: errorMessage,
            };
        }
    });
    // 用户确认后手动触发下载
    ipcMain.handle(IPC_CHANNELS.UPDATER_DOWNLOAD, async () => {
        if (isDev)
            return { success: false, error: 'dev mode' };
        logger.info('[Updater] 用户触发下载更新');
        try {
            await autoUpdater.downloadUpdate();
            return { success: true };
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`[Updater] 下载更新失败: ${msg}`);
            return { success: false, error: msg };
        }
    });
    // 安装更新并重启
    ipcMain.handle(IPC_CHANNELS.UPDATER_INSTALL, async () => {
        if (isDev)
            return { success: false, error: 'dev mode' };
        if (!options.requestQuit) {
            logger.error('[Updater] lifecycle quit coordinator is unavailable');
            return { success: false, error: 'LIFECYCLE_UNAVAILABLE' };
        }
        const result = await options.requestQuit({ kind: 'install-update', source: 'updater-install' });
        if (result.status === 'rejected') {
            const error = result.error;
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error ?? 'INSTALL_REJECTED'),
            };
        }
        // A concurrent quit intent may have already claimed the single TerminalPlan
        // ownership before this install request arrived. In that case requestQuit
        // resolves with the *pre-existing* owner's plan (e.g. a plain exit-0 quit),
        // not our install plan — the installer never runs. Only report success when
        // the accepted terminal action is actually an install; otherwise surface
        // that the install was superseded so the caller does not falsely believe
        // the update was applied.
        if (result.plan.kind !== 'install') {
            logger.warn(`[Updater] install intent was superseded by a concurrent '${result.plan.kind}' quit; installer not executed`);
            return { success: false, error: 'INSTALL_SUPERSEDED' };
        }
        if (result.terminalOutcome !== 'dispatched') {
            logger.error('[Updater] installer terminal action failed');
            return { success: false, error: 'INSTALL_FAILED' };
        }
        logger.info('[Updater] installer terminal action dispatched by lifecycle coordinator');
        return { success: true };
    });
    // 设置是否自动安装更新（由渲染进程从 Apollo agentConfig 推送）
    ipcMain.handle(IPC_CHANNELS.UPDATER_SET_AUTO_UPDATE, (_event, enabled) => {
        logger.info(`[Updater] setAutoUpdateEnabled: ${enabled}`);
        setAutoUpdateEnabled(enabled === true);
    });
    // 获取当前版本
    ipcMain.handle(IPC_CHANNELS.UPDATER_GET_VERSION, () => {
        return autoUpdater.currentVersion.version;
    });
}
/**
 * 设置自动更新 IPC 处理器
 */
export function setupUpdaterIPC(options = {}) {
    // 开发环境不启用自动更新，但仍需注册 IPC handlers
    if (isDev) {
        logger.info('[Updater] 开发环境，仅注册 IPC handlers');
        setupUpdaterIPCHandlers(options);
        return;
    }
    // 初始化更新模块（配置、事件监听、启动检查）
    initUpdater();
    // 设置 IPC 处理器
    setupUpdaterIPCHandlers(options);
}
