/**
 * 渲染进程热更新模块
 *
 * 版本格式：{appVersion}-renderer.{n}
 *
 * - 启动时 getHotUpdateBootRenderer() 决定本进程固定的渲染资源根目录（内置 out/ 或
 *   userData/hot-update/versions/<version>/），协议层只从该目录读取静态资源。
 * - 新版本下载、验签后安装为 pending，下次启动生效；首屏可见后确认健康，
 *   连续多次未确认会自动回滚。
 * - 清除缓存或收到 rollback manifest 后，下次启动回到安装包内置资源。
 */

export { HOT_UPDATE_CHANNEL, HOT_UPDATE_CDN_ROOT, MANIFEST_FILENAME, HOT_UPDATE_DIR, STATE_FILENAME, SHELL_FINGERPRINT_FILENAME, CHECK_INTERVAL } from "./config";

export { getHotUpdateDir, getAppVersion, getBaseAppVersion } from "./utils";

import { onElectronFirstContentVisible } from "../observability/startup-performance";
import { HotUpdateManager } from "./manager";
export { HotUpdateManager };
export let hotUpdateManager = HotUpdateManager.getInstance();
export const getHotUpdateBootRenderer = () => hotUpdateManager.getBootRenderer();

export const handleHotUpdateFirstContentVisible = () => hotUpdateManager.handleFirstContentVisible();

export const checkForHotUpdate = (force) => hotUpdateManager.checkForUpdate(force);

export const clearHotUpdateCache = () => hotUpdateManager.clearCache();

export const getHotUpdateStatus = () => hotUpdateManager.getStatus();

export const isHotUpdateEnabled = () => hotUpdateManager.isEnabled();

export const setHotUpdateEnabled = (enabled) => hotUpdateManager.setEnabled(enabled);

/** 订阅首屏可见（健康确认）并启动自动检查；由 lifecycle hot-update-auto-check 模块调用 */
export const startHotUpdateAutoCheck = () => {
    onElectronFirstContentVisible(() => hotUpdateManager.handleFirstContentVisible());
    hotUpdateManager.startAutoCheck();
};

export const stopHotUpdateAutoCheck = () => hotUpdateManager.stopAutoCheck();

