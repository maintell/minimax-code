/**
 * 窗口控制 IPC 处理
 */
import { ipcMain } from "electron";
import { classifyDesktopLoginError } from "@mavis/shared/desktop-login-diagnostics";
import { IPC_CHANNELS } from "../config/constants";
import { openExternalTarget } from "../utils/open-external-target";
import logger from "../utils/logger";
import { getMainWindow } from "../windows/mainWindow";
function getExternalUrlLogContext(url) {
    try {
        const { protocol, hostname, pathname } = new URL(url);
        return { protocol, hostname, pathname };
    }
    catch {
        return { urlType: 'relative_or_invalid' };
    }
}
/**
 * 设置窗口控制 IPC 处理器
 */
export function setupWindowIPC() {
    // 最小化窗口
    ipcMain.handle(IPC_CHANNELS.WINDOW_MINIMIZE, () => {
        getMainWindow()?.minimize();
    });
    // 恢复窗口（从最小化状态恢复并聚焦）
    ipcMain.handle(IPC_CHANNELS.WINDOW_RESTORE, () => {
        const mainWindow = getMainWindow();
        if (mainWindow) {
            mainWindow.restore();
            mainWindow.focus();
        }
    });
    // 最大化/还原窗口
    ipcMain.handle(IPC_CHANNELS.WINDOW_MAXIMIZE, () => {
        const mainWindow = getMainWindow();
        if (mainWindow?.isMaximized()) {
            mainWindow.unmaximize();
        }
        else {
            mainWindow?.maximize();
        }
        return mainWindow?.isMaximized();
    });
    // 关闭窗口
    ipcMain.handle(IPC_CHANNELS.WINDOW_CLOSE, () => {
        getMainWindow()?.close();
    });
    // 检查窗口是否最大化（包括全屏状态）
    ipcMain.handle(IPC_CHANNELS.WINDOW_IS_MAXIMIZED, () => {
        const mainWindow = getMainWindow();
        // macOS 上点击绿色按钮是进入全屏，需要同时检查
        return mainWindow?.isMaximized();
    });
    // 检查窗口是否全屏
    ipcMain.handle(IPC_CHANNELS.WINDOW_IS_FULL_SCREEN, () => {
        const mainWindow = getMainWindow();
        return mainWindow?.isFullScreen();
    });
    // 打开外部链接
    ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, async (_, url) => {
        try {
            await openExternalTarget(url);
            logger.info({
                msg: '[WindowIPC] external target open resolved',
                ...getExternalUrlLogContext(url),
            });
            return { success: true };
        }
        catch (error) {
            const errorMessage = String(error);
            logger.error({
                msg: '[WindowIPC] external target open failed',
                ...getExternalUrlLogContext(url),
                error: errorMessage,
            });
            const diagnostics = classifyDesktopLoginError(error, 'browser_open_failed', process.platform);
            return {
                success: false,
                error: errorMessage,
                diagnostics,
                ...(diagnostics.errorCode === 'no_default_browser'
                    ? { errorCode: 'no_default_browser' }
                    : {}),
            };
        }
    });
}
