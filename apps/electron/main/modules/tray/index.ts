/**
 * 系统托盘模块
 * 在系统托盘区域显示图标，支持点击唤起应用
 */
import { getTrayIcon } from "./icon";
import { Menu, app, Tray, nativeImage } from "electron";
import { DISPLAY_NAME } from "../../config/constants";
import { bringToFront } from "../../utils/window";
import { getDesktopConfig } from "../../ipc/storage.ipc";
import { toggleArchonMiniChatWindow } from "../../windows";
import { windowManager } from "../../windows/manager";
let tray = null;
let trayQuitHandler;
/**
 * 创建托盘右键菜单：小窗 + 退出
 */
export function createContextMenu() {
    const config = getDesktopConfig();
    const isEnLanguage = config.language === 'en';
    return Menu.buildFromTemplate([
        {
            label: isEnLanguage ? 'Mini Chat' : '打开小窗',
            click: () => {
                const windowType = windowManager.getWindowType();
                if (windowType === 'archon') {
                    toggleArchonMiniChatWindow();
                }
            },
        },
        { type: 'separator' },
        {
            label: isEnLanguage ? 'Quit' : '退出',
            click: () => {
                if (trayQuitHandler) {
                    trayQuitHandler();
                    return;
                }
                app.quit();
            },
        },
    ]);
}
/**
 * 创建系统托盘
 */
export function createTray(options = {}) {
    trayQuitHandler = options.onQuit;
    if (tray) {
        tray.destroy();
        tray = null;
    }
    try {
        const icon = getTrayIcon();
        if (icon.isEmpty()) {
            console.error('[Tray] Failed to load any tray icon');
            return null;
        }
        tray = new Tray(icon);
        tray.setToolTip(DISPLAY_NAME);
        applyTrayBehavior(tray);
        return tray;
    }
    catch (error) {
        console.error('[Tray] Failed to create:', error);
        return null;
    }
}
/**
 * Apply unified tray behavior for both modes:
 * left-click → bring main window to front, right-click → context menu (mini chat + quit)
 */
function applyTrayBehavior(t) {
    t.removeAllListeners('click');
    t.removeAllListeners('right-click');
    t.removeAllListeners('double-click');
    // Don't use setContextMenu — it intercepts left-click on macOS
    t.setContextMenu(null);
    t.on('click', () => {
        bringToFront();
    });
    t.on('right-click', () => {
        t.popUpContextMenu(createContextMenu());
    });
}
/**
 * 销毁托盘
 */
export function destroyTray() {
    if (tray) {
        tray.destroy();
        tray = null;
    }
}
/**
 * 获取托盘实例
 */
export function getTray() {
    return tray;
}
/**
 * 刷新托盘右键菜单（窗口模式切换时调用）
 */
export function refreshTrayMenu() {
    if (tray) {
        applyTrayBehavior(tray);
    }
}
/**
 * 设置托盘图标
 */
export function setTrayIcon(iconPath) {
    if (tray) {
        const icon = nativeImage.createFromPath(iconPath);
        if (process.platform === 'darwin') {
            icon.setTemplateImage(true);
        }
        tray.setImage(icon);
    }
}
/**
 * 设置托盘提示文字
 */
export function setTrayTooltip(tooltip) {
    if (tray) {
        tray.setToolTip(tooltip);
    }
}
