/**
 * Log Viewer Window 管理
 * 用于查看 electron-log 写入的日志文件
 * 仅在测试环境可用
 */
import * as path from "path";
import { nativeTheme } from "electron";
import { isTest, isStaging, isInternalBuild, PAGE_URLS } from "../config";
import { createDesktopRendererWindow } from "./desktopRendererWindow";
// 当前日志查看器窗口引用
let logViewerWindow = null;
/**
 * 获取日志查看器窗口引用
 */
export function getLogViewerWindow() {
    return logViewerWindow;
}
/**
 * 创建或显示日志查看器窗口
 */
export async function createLogViewerWindow() {
    // 仅在测试环境可用
    if (!isTest && !isStaging && !isInternalBuild) {
        console.warn('[LogViewer] Only available in test or staging environment');
        return;
    }
    // 如果窗口已存在且未销毁，只显示
    if (logViewerWindow && !logViewerWindow.isDestroyed()) {
        logViewerWindow.show();
        logViewerWindow.focus();
        return;
    }
    // 创建新窗口
    logViewerWindow = createDesktopRendererWindow('log-viewer', {
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        title: 'Log Viewer',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js'),
            webSecurity: true,
        },
        show: false,
    });
    // 窗口准备好后显示
    logViewerWindow.once('ready-to-show', () => {
        logViewerWindow?.show();
        logViewerWindow?.focus();
    });
    // 加载日志查看器页面
    const url = PAGE_URLS.LOG_VIEWER;
    logViewerWindow.loadURL(url);
    // 窗口关闭事件
    logViewerWindow.on('closed', () => {
        logViewerWindow = null;
        console.log('[LogViewer] Window closed');
    });
    console.log('[LogViewer] Window created');
}
/**
 * 关闭日志查看器窗口
 */
export function closeLogViewerWindow() {
    if (logViewerWindow && !logViewerWindow.isDestroyed()) {
        logViewerWindow.close();
    }
}
