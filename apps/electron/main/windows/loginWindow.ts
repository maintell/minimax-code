/**
 * 登录窗口
 * 用户未登录时显示
 */
import * as path from "path";
import { app } from "electron";
import { LOGIN_WINDOW_WIDTH, LOGIN_WINDOW_HEIGHT, MAIN_WINDOW_TITLE, isDev, PAGE_URLS } from "../config";
import { setupLoginMenu } from "../modules/menu";
import { waitForServer } from "../utils";
import { getTitleBarStyle, getBackgroundColor, DEFAULT_SECURE_WEB_PREFERENCES } from "./utils";
import { recordElectronStartupMainMilestone } from "../modules/observability/startup-performance";
import { createDesktopRendererWindow } from "./desktopRendererWindow";
/**
 * 创建登录窗口
 */
export async function createLoginWindow(context) {
    const window = createDesktopRendererWindow('login', {
        width: LOGIN_WINDOW_WIDTH,
        height: LOGIN_WINDOW_HEIGHT,
        resizable: false,
        title: MAIN_WINDOW_TITLE,
        titleBarStyle: getTitleBarStyle(process.platform),
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: getBackgroundColor(),
        webPreferences: {
            ...DEFAULT_SECURE_WEB_PREFERENCES,
            preload: path.join(__dirname, '..', 'preload.js'),
        },
        show: false,
    });
    recordElectronStartupMainMilestone('browser_window_created');
    context.setWindow(window);
    context.setWindowType('login');
    // 窗口准备好后显示
    window.once('ready-to-show', () => {
        window?.show();
        window?.focus();
    });
    // 加载登录页
    if (isDev) {
        const serverReady = await waitForServer(PAGE_URLS.LOGIN);
        if (serverReady) {
            recordElectronStartupMainMilestone('next_server_ready');
            await new Promise((resolve) => setTimeout(resolve, 500));
            recordElectronStartupMainMilestone('load_url_started');
            window.loadURL(PAGE_URLS.LOGIN);
        }
        else {
            console.error('Failed to connect to Next.js server');
            app.quit();
            return;
        }
        // window.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        recordElectronStartupMainMilestone('load_url_started');
        window.loadURL(PAGE_URLS.LOGIN);
    }
    // 窗口关闭事件
    window.on('closed', () => {
        // Login can close after the product window has already taken ownership.
        if (context.getWindow() !== window)
            return;
        context.setWindow(null);
        context.setWindowType(null);
    });
    // 设置登录窗口的简化菜单
    setupLoginMenu();
}
