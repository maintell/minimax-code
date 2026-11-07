/**
 * 系统通知 IPC 处理
 * 使用 Electron 主进程的 Notification API
 * 即使窗口隐藏也能发送通知
 */
import path from "path";
import { randomUUID } from "node:crypto";
import { Notification, app, ipcMain } from "electron";
import { IPC_CHANNELS } from "../config/constants";
import { getMainWindow } from "../windows";
import { isDev } from "../config/env";
import { NotificationClickPayloadStore } from "./notification-click-payloads";
const retainedNotifications = new Map();
let payloadStore;
let notificationRestorePromise = Promise.resolve();
/**
 * 显示系统通知
 */
async function showNotification(options) {
    const { title, body, icon, silent = false, data, skipFocusCheck = false } = options;
    // 检查是否支持通知
    if (!Notification.isSupported()) {
        console.warn('[Notification] System notifications not supported');
        return;
    }
    // 检查窗口是否聚焦，如果聚焦则不发送系统通知
    // skipFocusCheck 为 true 时跳过此检查（由渲染进程自行判断是否需要通知）
    if (!skipFocusCheck) {
        const mainWindow = getMainWindow();
        if (mainWindow && mainWindow.isFocused()) {
            // 窗口已聚焦，通过 IPC 通知渲染进程更新 UI 即可
            return;
        }
    }
    // macOS 自带左侧应用图标，显式 icon 会变成右侧附件，导致 logo 重复。
    let iconPath;
    if (process.platform !== 'darwin') {
        iconPath = icon;
        if (!iconPath) {
            if (isDev) {
                iconPath = path.join(__dirname, '../../resources/tray.png');
            }
            else {
                iconPath = path.join(process.resourcesPath, 'resources', 'tray.png');
            }
        }
    }
    const id = `mavis-notification-${randomUUID()}`;
    const notification = new Notification({
        id,
        title,
        body,
        silent,
        ...(iconPath ? { icon: iconPath } : {}),
    });
    if (data)
        payloadStore?.put(id, data);
    retainNotification(notification, data);
    notification.show();
}
function retainNotification(notification, data) {
    const id = notification.id;
    retainedNotifications.set(id, notification);
    const release = () => {
        retainedNotifications.delete(id);
        payloadStore?.delete(id);
    };
    notification.on('click', () => {
        activateAndDispatch(data);
        release();
    });
    notification.on('close', release);
    notification.on('failed', release);
}
function activateAndDispatch(data) {
    const win = getMainWindow();
    if (!win || win.isDestroyed())
        return;
    if (win.isMinimized())
        win.restore();
    win.show();
    win.focus();
    if (data && !win.webContents.isDestroyed()) {
        win.webContents.send(IPC_CHANNELS.NOTIFICATION_CLICK, data);
    }
}
async function restoreDeliveredNotifications() {
    if (process.platform !== 'darwin')
        return;
    const getHistory = Notification.getHistory;
    if (typeof getHistory !== 'function')
        return;
    try {
        const delivered = await getHistory.call(Notification);
        const deliveredIds = new Set(delivered.map((notification) => notification.id));
        for (const notification of delivered) {
            retainNotification(notification, payloadStore?.get(notification.id));
        }
        payloadStore?.retainOnly(deliveredIds);
    }
    catch (error) {
        console.warn('[Notification] Failed to restore delivered notifications:', error);
    }
}
/**
 * 设置通知 IPC 处理器
 */
export function setupNotificationIPC() {
    payloadStore = new NotificationClickPayloadStore(path.join(app.getPath('userData'), 'notification-click-payloads.json'));
    ipcMain.handle(IPC_CHANNELS.NOTIFICATION_SHOW, async (_event, options) => {
        try {
            // Keep startup non-blocking while preventing history cleanup from racing a new delivery.
            await notificationRestorePromise;
            await showNotification(options);
            return { success: true };
        }
        catch (error) {
            console.error('[Notification] Failed to show notification:', error);
            return { success: false, error: String(error) };
        }
    });
    notificationRestorePromise = restoreDeliveredNotifications();
}
