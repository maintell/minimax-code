/**
 * 渲染进程热更新模块
 *
 * 版本格式：{appVersion}-renderer.{n}
 * 例如：3.0.3-renderer.1, 3.0.3-renderer.2
 *
 * 工作流程：
 * 1. 构建 App 时使用默认的 out/ 资源（没有热更新版本）
 * 2. 发布热更新时，生成 manifest.json 和 zip 包上传到 CDN
 * 3. 用户打开 App → 检测到热更新 → 下载 → 应用
 * 4. 如需回退，清除缓存即可使用打包时的版本
 */

// 导出配置
export { HOT_UPDATE_BASE_URL, MANIFEST_FILENAME, HOT_UPDATE_DIR, STATE_FILENAME, CHECK_INTERVAL, DEFAULT_MIN_APP_VERSION } from "./config";

// 导出工具函数
export { getHotUpdateDir, getHotUpdateResourceDir, ensureDir, fetchText, calculateFileSha256, downloadFile, parseRendererVersion, compareRendererVersions, getAppVersion, getBaseAppVersion } from "./utils";

// 导出状态管理
export { readState, saveState } from "./state";

// 导出管理器
import { HotUpdateManager } from "./manager";
export { HotUpdateManager };
// 导出单例
export let hotUpdateManager = HotUpdateManager.getInstance();
// 导出便捷函数
export const checkForHotUpdate = (force) => hotUpdateManager.checkForUpdate(force);

export const downloadAndApplyHotUpdate = (manifest) => hotUpdateManager.downloadAndApply(manifest);

export const clearHotUpdateCache = () => hotUpdateManager.clearCache();

export const getHotUpdateStatus = () => hotUpdateManager.getStatus();

export const isHotUpdateEnabled = () => hotUpdateManager.isEnabled();

export const setHotUpdateEnabled = (enabled) => hotUpdateManager.setEnabled(enabled);

