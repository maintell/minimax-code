/**
 * Electron 主进程入口文件
 *
 * 职责：
 * - 初始化环境变量
 * - 注册协议 scheme
 * - 应用生命周期管理
 * - 整合各模块
 */

// 必须最先导入，加载环境变量
import os from "node:os";
import { app } from "electron";
import { recordElectronStartupMainEntry } from "./modules/observability/startup-performance";
import { isDev, isTest, isStaging, isInternalBuild, isZh, buildEnv } from "./config";
import { setConfiguredLocalRuntimeDataParentDir, synchronizeLocalRuntimeDataDirEnv } from "./modules/local-runtime/data-dir";
import { resolveDevelopmentUserDataPath } from "./config/development-user-data";
import { resolveAppIdentity } from "./config/app-identity";
import { resolveDevelopmentSwimLaneOverride } from "./config/development-swim-lane";
import logger from "./utils/logger";
recordElectronStartupMainEntry();
function readDevIdentityEnv(name) {
    if (!isDev)
        return undefined;
    const value = process.env[name]?.trim();
    return value || undefined;
}
// 身份解析规则见 config/app-identity.ts（包身份轴 vs 后端环境轴）。
// UI 显示名称使用 config/constants.ts 中的 DISPLAY_NAME。
function getAppNameAndId() {
    return resolveAppIdentity({
        isDev: isDev,
        isTest: isTest,
        isStaging: isStaging,
        isInternalBuild: isInternalBuild,
        isZh: isZh,
        devAppName: readDevIdentityEnv('MAVIS_ELECTRON_DEV_APP_NAME'),
        devAppId: readDevIdentityEnv('MAVIS_ELECTRON_DEV_APP_ID'),
    });
}
// 设置应用名称和 AppUserModelId，确保 Windows 下单实例锁和协议处理正常工作
// 必须在 requestSingleInstanceLock 之前设置
const { appName: APP_NAME, appId: APP_ID, userDataAppName: USER_DATA_APP_NAME } = getAppNameAndId();
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
// 开发环境下设置数据目录名称，确保不同环境数据隔离
// 生产环境由 electron-builder 的 productName 自动设置
// 必须在 app ready 之前设置
if (isDev) {
    const userDataPath = app.getPath('userData');
    // 普通开发沿用共享目录；隔离验收显式传入独立绝对路径，避免恢复其他开发实例的窗口状态。
    const newUserDataPath = resolveDevelopmentUserDataPath({
        defaultUserDataPath: userDataPath,
        userDataAppName: USER_DATA_APP_NAME,
        override: process.env.MAVIS_ELECTRON_DEV_USER_DATA_DIR,
    });
    app.setPath('userData', newUserDataPath);
}
const { getDesktopConfig, setDesktopConfig } = require('./ipc/storage.ipc');
const developmentSwimLaneOverride = resolveDevelopmentSwimLaneOverride(process.argv, isDev);
const desktopConfig = getDesktopConfig();
setConfiguredLocalRuntimeDataParentDir(typeof desktopConfig.localRuntimeDataParentDir === 'string'
    ? desktopConfig.localRuntimeDataParentDir
    : null);
// This must run before any Electron main-process config consumer reads
// config.yaml, so it shares the configured runtime data directory.
synchronizeLocalRuntimeDataDirEnv();
const { acquireSingleInstanceLock, setupDeepLinkEventHandlers } = require('./modules/deeplink');
const hasSingleInstanceLock = acquireSingleInstanceLock();
if (hasSingleInstanceLock)
    setupDeepLinkEventHandlers();
if (hasSingleInstanceLock) {
    const { setupFileOpenEventHandlers } = require('./modules/dock');
    setupFileOpenEventHandlers();
}
const { applyGpuGuard, isGpuDisabledByGuard } = require('./modules/gpu-guard');
const gpuGuardReason = hasSingleInstanceLock ? applyGpuGuard() : null;
if (gpuGuardReason) {
    logger.warn(`[GpuGuard] Hardware acceleration disabled: ${gpuGuardReason}`);
}
logger.info(`[Electron] App name: ${app.getName()} \n App ID: ${APP_ID} \n buildEnv: ${buildEnv} \n app userdata path: ${app.getPath('userData')}`);
// Log device information for diagnostics
try {
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model.trim() : 'Unknown';
    const totalMemGB = (os.totalmem() / 1024 ** 3).toFixed(1);
    const osName = process.platform === 'darwin'
        ? 'macOS'
        : process.platform === 'win32'
            ? 'Windows'
            : process.platform;
    logger.info(`[Electron] Device info:` +
        `\n  OS: ${osName} ${os.release()} (${process.arch})` +
        `\n  CPU: ${cpuModel} (${cpus.length} cores)` +
        `\n  Memory: ${totalMemGB} GB` +
        `\n  Electron: ${process.versions.electron}` +
        `\n  Chrome: ${process.versions.chrome}` +
        `\n  Node: ${process.versions.node}` +
        `\n  GPU acceleration: ${isGpuDisabledByGuard() ? 'disabled (software)' : 'enabled'}`);
}
catch (error) {
    logger.warn(`[Electron] Failed to collect device info: ${String(error)}`);
}
if (hasSingleInstanceLock) {
    if (developmentSwimLaneOverride !== undefined) {
        setDesktopConfig({ swimLaneName: developmentSwimLaneOverride });
        logger.info(`[Electron] Development swim lane: ${developmentSwimLaneOverride || 'default'}`);
    }
    const { bootstrapElectronApplication } = require('./lifecycle/application-bootstrap-production');
    bootstrapElectronApplication({ singleInstanceLockAlreadyAcquired: true });
}
