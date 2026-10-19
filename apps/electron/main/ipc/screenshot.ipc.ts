/**
 * Screenshot IPC Handlers
 * 处理截图相关的 IPC 通信
 */
import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { startScreenshot } from "../modules/screenshot";
import { hideArchonMiniChatWindow, showArchonMiniChatWindow } from "../windows/archonMiniChatWindow";
import { windowManager } from "../windows";
function isArchonMode() {
    return windowManager.getWindowType() === 'archon';
}
function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function parseCaptureRegion(value) {
    if (!value || typeof value !== 'object')
        return null;
    const record = value;
    const x = finiteNumber(record.x);
    const y = finiteNumber(record.y);
    const width = finiteNumber(record.width);
    const height = finiteNumber(record.height);
    if (x === null || y === null || width === null || height === null)
        return null;
    if (width <= 0 || height <= 0)
        return null;
    return {
        x: Math.max(0, Math.round(x)),
        y: Math.max(0, Math.round(y)),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
    };
}
/**
 * 设置截图相关的 IPC 处理器
 */
export function setupScreenshotIPC() {
    ipcMain.handle(IPC_CHANNELS.SCREENSHOT_CAPTURE_PAGE_REGION, async (event, value) => {
        const rect = parseCaptureRegion(value);
        if (!rect) {
            throw new Error('Invalid capture region');
        }
        const targetWindow = BrowserWindow.fromWebContents(event.sender) ??
            windowManager.getWindowByType('archon') ??
            windowManager.getWindow();
        if (!targetWindow || targetWindow.isDestroyed()) {
            throw new Error('No active window to capture');
        }
        const image = await targetWindow.webContents.capturePage(rect);
        if (image.isEmpty()) {
            throw new Error('Captured image is empty');
        }
        return image.toDataURL();
    });
    /**
     * 开始截图
     * 返回截图文件路径
     */
    ipcMain.handle(IPC_CHANNELS.SCREENSHOT_START, async (_, params) => {
        try {
            console.log('[Screenshot IPC] Starting screenshot with params:', params);
            // 隐藏小窗
            hideArchonMiniChatWindow();
            // 等待 100ms 开始截图
            await new Promise((resolve) => setTimeout(resolve, 100));
            const filePath = await startScreenshot(params?.workspaceDir);
            showArchonMiniChatWindow();
            console.log('[Screenshot IPC] Screenshot saved:', filePath);
            return {
                success: true,
                filePath,
            };
        }
        catch (error) {
            console.error('[Screenshot IPC] Screenshot failed:', error);
            showArchonMiniChatWindow();
            // 判断错误类型
            let errorType = 'error';
            let errorMessage = 'Unknown error';
            if (error instanceof Error) {
                errorMessage = error.message;
                // 检查错误类型
                if (error.type === 'permission') {
                    errorType = 'permission';
                }
                else if (errorMessage.includes('cancelled') || errorMessage.includes('canceled')) {
                    errorType = 'cancelled';
                }
            }
            else {
                errorMessage = String(error);
            }
            return {
                success: false,
                error: errorMessage,
                errorType,
            };
        }
    });
}
