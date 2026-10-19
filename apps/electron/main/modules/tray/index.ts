/**
 * 系统托盘模块
 * 在系统托盘区域显示图标，支持点击唤起应用
 */
import * as path from "path";
import { app, nativeImage, Menu, Tray } from "electron";
import { isDev } from "../../config";
import { DISPLAY_NAME } from "../../config/constants";
import { bringToFront } from "../../utils/window";
import { getDesktopConfig } from "../../ipc/storage.ipc";
import { toggleArchonMiniChatWindow } from "../../windows";
import { windowManager } from "../../windows/manager";
let tray = null;
let trayQuitHandler;
/**
 * 获取托盘图标
 * macOS: 需要使用 Template 图标（16x16 或 22x22，黑白色）
 * Windows: 可以使用彩色图标（建议 16x16 或 32x32）
 *
 * 图标文件说明：
 * - resources/trayTemplate.png: macOS 托盘图标（22x22，黑色模板，透明背景）
 * - resources/trayTemplate@2x.png: macOS Retina 托盘图标（44x44，macOS 自动加载）
 * - resources/tray.png: Windows/Linux 托盘图标（32x32，可彩色）
 * - resources/tray.ico: Windows 托盘图标（多尺寸 ico 文件）
 */
function getTrayIcon() {
    const resourcesPath = isDev
        ? path.join(app.getAppPath(), 'resources')
        : path.join(process.resourcesPath, 'resources');
    let icon;
    if (process.platform === 'darwin') {
        // macOS: 尝试加载 Template 图标
        const templatePath = path.join(resourcesPath, 'trayTemplate.png');
        icon = nativeImage.createFromPath(templatePath);
        if (icon.isEmpty()) {
            // 如果没有专用托盘图标，使用应用图标并调整大小
            const icnsPath = path.join(resourcesPath, 'icon.icns');
            icon = nativeImage.createFromPath(icnsPath);
            if (!icon.isEmpty()) {
                icon = icon.resize({ width: 22, height: 22 });
            }
        }
        // 设置为 Template 图标（自动适应系统主题）
        icon.setTemplateImage(true);
    }
    else if (process.platform === 'win32') {
        // Windows: 尝试加载 ico 或 png
        const icoPath = path.join(resourcesPath, 'tray.ico');
        const pngPath = path.join(resourcesPath, 'tray.png');
        icon = nativeImage.createFromPath(icoPath);
        if (icon.isEmpty()) {
            icon = nativeImage.createFromPath(pngPath);
        }
        if (icon.isEmpty()) {
            // 使用应用图标
            const iconPath = path.join(resourcesPath, 'icon.ico');
            icon = nativeImage.createFromPath(iconPath);
            if (!icon.isEmpty()) {
                icon = icon.resize({ width: 32, height: 32 });
            }
        }
    }
    else {
        // Linux
        const pngPath = path.join(resourcesPath, 'tray.png');
        icon = nativeImage.createFromPath(pngPath);
        if (icon.isEmpty()) {
            const icnsPath = path.join(resourcesPath, 'icon.icns');
            icon = nativeImage.createFromPath(icnsPath);
            if (!icon.isEmpty()) {
                icon = icon.resize({ width: 22, height: 22 });
            }
        }
    }
    return icon;
}
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
