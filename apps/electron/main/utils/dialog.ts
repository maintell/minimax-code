/**
 * 对话框相关工具函数
 */
import { BrowserWindow } from "electron";
/**
 * 显示对话框而不产生遮罩层
 *
 * 不传父窗口给 dialog API，使系统显示为独立居中对话框（而非 sheet），
 * 同时禁用父窗口鼠标交互以模拟模态效果。
 */
export async function showDialogWithoutOverlay(parentWindow, dialogFn) {
    if (!parentWindow) {
        return dialogFn(undefined);
    }
    // 禁用父窗口鼠标交互（模拟模态效果，阻止用户在文件选择期间操作小窗）
    parentWindow.setIgnoreMouseEvents(true);
    try {
        // 不传父窗口，显示为独立居中对话框，避免 macOS sheet 从底部弹出
        const result = await dialogFn(undefined);
        return result;
    }
    finally {
        // 恢复父窗口鼠标交互
        if (!parentWindow.isDestroyed()) {
            parentWindow.setIgnoreMouseEvents(false);
        }
    }
}
/**
 * 根据 webContents 获取所属的 BrowserWindow
 * 支持主窗口和 WebContentsView
 */
export function getWindowFromEvent(event) {
    // 尝试从 event.sender 获取窗口
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (senderWindow) {
        return senderWindow;
    }
    // 如果 sender 是 WebContentsView，尝试获取其父窗口
    // WebContentsView 的 webContents 没有直接关联 BrowserWindow
    // 但我们可以遍历所有窗口找到包含这个 webContents 的窗口
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
        // 检查主窗口的 webContents
        if (win.webContents.id === event.sender.id) {
            return win;
        }
        // 检查子视图
        const views = win.contentView?.children || [];
        for (const view of views) {
            if ('webContents' in view && view.webContents?.id === event.sender.id) {
                return win;
            }
        }
    }
    return null;
}
/**
 * 解析对话框的父窗口
 *
 * 策略：
 * 1. 优先从 IPC 事件中获取发送方窗口（最准确）
 * 2. 尝试获取当前焦点窗口（用户正在交互的窗口）
 * 3. 回退到主窗口
 *
 * @param event IPC 事件
 * @param getMainWindow 获取主窗口的函数
 */
export function resolveParentWindow(event, getMainWindow) {
    // 1. 优先从事件中获取发送方窗口
    const fromEvent = getWindowFromEvent(event);
    if (fromEvent)
        return fromEvent;
    // 2. 尝试获取当前焦点窗口（自动处理所有窗口类型，包括 MiniChat）
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed())
        return focused;
    // 3. 回退到主窗口
    return getMainWindow();
}
