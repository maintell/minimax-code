/**
 * 热更新 IPC 处理模块
 *
 * 提供渲染进程与热更新模块的通信接口
 */

import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../config";
import { checkForHotUpdate, clearHotUpdateCache, hotUpdateManager, startHotUpdateAutoCheck as hotUpdateStartHotUpdateAutoCheck, stopHotUpdateAutoCheck as hotUpdateStopHotUpdateAutoCheck } from "../modules/hotUpdate";
import { getCategoryLogger } from "../utils/logger";
import { getMainWindow } from "../windows/mainWindow";
const logger = getCategoryLogger('update');
/**
 * 设置热更新 IPC 处理器
 */
export function setupHotUpdateIPC() {
    // 检查热更新（有新版本时自动下载安装，下次启动生效）
    ipcMain.handle(IPC_CHANNELS.HOT_UPDATE_CHECK, async (_event, force) => {
        try {
            logger.info(`[HotUpdate IPC] Check for update, force: ${force}`);
            const result = await checkForHotUpdate(force);
            return result;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[HotUpdate IPC] Check failed: ${errorMessage}`);
            return { success: false, error: errorMessage };
        }
    });
    // 清除缓存（下次启动回到打包版本）
    ipcMain.handle(IPC_CHANNELS.HOT_UPDATE_CLEAR_CACHE, async () => {
        try {
            logger.info('[HotUpdate IPC] Clear cache (rollback to bundled version)');
            const success = await clearHotUpdateCache();
            return { success };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(`[HotUpdate IPC] Clear cache failed: ${errorMessage}`);
            return { success: false, error: errorMessage };
        }
    });
    // 重新加载主窗口。渲染资源根目录在进程内固定，热更新版本需重启应用才会生效。
    ipcMain.handle(IPC_CHANNELS.HOT_UPDATE_RELOAD, () => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            logger.info('[HotUpdate IPC] Reloading page to apply update');
            mainWindow.webContents.reload();
            return { success: true };
        }
        return { success: false, error: 'No main window' };
    });
    // 获取当前热更新版本（异步）
    ipcMain.handle(IPC_CHANNELS.HOT_UPDATE_GET_VERSION, () => {
        return hotUpdateManager.getCurrentVersion();
    });
    // 获取当前热更新版本（同步，用于 preload 初始化）
    ipcMain.on(IPC_CHANNELS.HOT_UPDATE_GET_VERSION_SYNC, (event) => {
        event.returnValue = hotUpdateManager.getCurrentVersion();
    });
}
/**
 * 启动热更新自动检查（由 lifecycle hot-update-auto-check 模块调用）
 */
export function startHotUpdateAutoCheck() {
    hotUpdateStartHotUpdateAutoCheck();
}
/**
 * 停止热更新自动检查
 */
export function stopHotUpdateAutoCheck() {
    hotUpdateStopHotUpdateAutoCheck();
}
