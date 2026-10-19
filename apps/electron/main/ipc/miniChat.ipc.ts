/**
 * Mini Chat Window IPC 处理器
 * 处理小窗的创建、关闭等操作
 * 根据当前窗口模式（archon/main）分发到不同的窗口管理函数
 */
import { ipcMain, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { createArchonMiniChatWindow, closeArchonMiniChatWindow, showArchonMiniChatWindow, hideArchonMiniChatWindow, resizeArchonMiniChatWindow, getArchonMiniChatWindow, setArchonMiniChatIgnoreMouseEvents } from "../windows/archonMiniChatWindow";
import { windowManager } from "../windows";
function isArchonMode() {
    return windowManager.getWindowType() === 'archon';
}
/**
 * 设置 Mini Chat Window 相关的 IPC 处理器
 */
export function setupMiniChatIPC() {
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_CREATE, async (_, chatId) => {
        try {
            await createArchonMiniChatWindow();
            return { success: true };
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to create window:', error);
            return { success: false, error: String(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_CLOSE, async () => {
        try {
            closeArchonMiniChatWindow();
            return { success: true };
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to close window:', error);
            return { success: false, error: String(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_SHOW, async () => {
        try {
            showArchonMiniChatWindow();
            return { success: true };
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to show window:', error);
            return { success: false, error: String(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_HIDE, async () => {
        try {
            hideArchonMiniChatWindow();
            return { success: true };
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to hide window:', error);
            return { success: false, error: String(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_RESIZE, async (_, height) => {
        try {
            resizeArchonMiniChatWindow(height);
            return { success: true };
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to resize window:', error);
            return { success: false, error: String(error) };
        }
    });
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_SET_IGNORE_MOUSE_EVENTS, async (event, ignore) => {
        try {
            if (typeof ignore !== 'boolean') {
                return { success: false, error: 'Invalid mouse event setting' };
            }
            const miniChatWindow = getArchonMiniChatWindow();
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (!miniChatWindow || miniChatWindow.isDestroyed() || senderWindow !== miniChatWindow) {
                return { success: false, error: 'Mini Chat window not found' };
            }
            setArchonMiniChatIgnoreMouseEvents(ignore);
            return { success: true };
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to update mouse events:', error);
            return { success: false, error: String(error) };
        }
    });
    /**
     * 展开到主窗口
     * archon 模式: 聚焦 archon 窗口，发送 sessionId 导航
     * main 模式: 聚焦 main 窗口，发送 chatId 到 tab
     */
    ipcMain.handle(IPC_CHANNELS.MINI_CHAT_MAXIMIZE, async (_, params) => {
        try {
            return await handleArchonMaximize(params?.sessionId, params?.pendingMessage, params?.source);
        }
        catch (error) {
            console.error('[MiniChat IPC] Failed to maximize:', error);
            return { success: false, error: String(error) };
        }
    });
}
async function handleArchonMaximize(sessionId, pendingMessage, source = 'local') {
    const archonWindow = windowManager.getWindowByType('archon');
    if (!archonWindow || archonWindow.isDestroyed()) {
        console.error('[MiniChat IPC] Archon window not found');
        return { success: false, error: 'Archon window not found' };
    }
    // Show and focus the archon window BEFORE hiding the mini chat.
    // On Windows, hiding the foreground window transfers focus to another app,
    // and window.focus() cannot steal it back due to the OS foreground lock.
    if (process.platform === 'win32') {
        archonWindow.setAlwaysOnTop(true);
        archonWindow.show();
        archonWindow.focus();
        archonWindow.setAlwaysOnTop(false);
    }
    else {
        windowManager.focusWindowByType('archon');
    }
    hideArchonMiniChatWindow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (sessionId) {
        archonWindow.webContents.send(IPC_CHANNELS.MAIN_WINDOW_SELECT_CHAT, {
            sessionId,
            pendingMessage,
            source,
        });
    }
    return { success: true };
}
