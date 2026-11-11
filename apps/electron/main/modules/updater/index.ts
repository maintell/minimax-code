/**
 * 更新模块入口
 *
 * 基于 electron-updater 实现应用的检查更新、下载、安装功能
 *
 * 触发方式（统一使用 React UI，灰度控制收口于渲染层）：
 * 1. 菜单栏检查更新 - 打开 React 弹窗
 * 2. 启动时静默检查 - 静默下载，退出时安装（无 UI）
 * 3. Feature 弹窗 / 设置页面按钮 - 打开 React 弹窗
 * 4. 渲染层定时轮询（每小时）
 */
import { isDev } from "../../config/env";
import { getCategoryLogger } from "../../utils/logger";
import { configureAutoUpdater, ensurePublicReleaseFeed } from "./config";
import { setupAutoUpdaterEvents } from "./events";
const logger = getCategoryLogger('update');
// 导出状态管理函数
export { setIsUserTriggeredCheck as setUserTriggeredCheck, getUpdateStatus, setUpdateStatus, isChecking, isDownloading, isDownloaded, isUpToDate, hasUpdateReady, resetTempFlags, resetUpdateCache, getCachedUpdateInfo, getCachedProgress, isAutoUpdateEnabled, setAutoUpdateEnabled, getDownloadedFilePath, isNativeUpdateReady } from "./state";

// 导出配置
export { getUpdateServerUrl, ensurePublicReleaseFeed } from "./config";

/**
 * 初始化更新模块
 * 配置 autoUpdater 并设置事件监听
 */
export function initUpdater() {
    if (isDev) {
        logger.info('[Updater] 开发环境，跳过自动更新初始化');
        return;
    }
    configureAutoUpdater();
    setupAutoUpdaterEvents();
    // 预热版本发现，让第一次检查不必等待 release feed 请求。失败时保持静默，
    // 由下一次检查重试并把错误返回渲染层。
    void ensurePublicReleaseFeed().catch((error) => {
        logger.warn(`[Updater] 预解析发布源失败: ${error instanceof Error ? error.message : String(error)}`);
    });
    logger.info('[Updater] 更新模块初始化完成');
}
