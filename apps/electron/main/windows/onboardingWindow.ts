/**
 * 引导窗口
 * 首次启动时显示，引导用户了解应用功能
 */
import * as path from "path";
import { app } from "electron";
import { ONBOARDING_WINDOW_WIDTH, ONBOARDING_WINDOW_HEIGHT, MAIN_WINDOW_TITLE, isDev, PAGE_URLS } from "../config";
import { setupLoginMenu } from "../modules/menu";
import { waitForServer } from "../utils";
import { getTitleBarStyle, getBackgroundColor, DEFAULT_SECURE_WEB_PREFERENCES } from "./utils";
import { createDesktopRendererWindow } from "./desktopRendererWindow";
/**
 * 创建引导窗口
 */
export async function createOnboardingWindow(context) {
    const isMac = process.platform === 'darwin';
    const window = createDesktopRendererWindow('onboarding', {
        width: ONBOARDING_WINDOW_WIDTH,
        height: ONBOARDING_WINDOW_HEIGHT,
        resizable: false,
        title: MAIN_WINDOW_TITLE,
        titleBarStyle: getTitleBarStyle(process.platform),
        trafficLightPosition: { x: 16, y: 16 },
        backgroundColor: getBackgroundColor(),
        // Windows 上隐藏菜单栏
        autoHideMenuBar: !isMac,
        webPreferences: {
            ...DEFAULT_SECURE_WEB_PREFERENCES,
            preload: path.join(__dirname, '..', 'preload.js'),
        },
        show: false,
    });
    context.setWindow(window);
    context.setWindowType('onboarding');
    // 窗口准备好后显示
    window.once('ready-to-show', () => {
        window?.show();
        window?.focus();
    });
    // 加载引导页
    if (isDev) {
        const serverReady = await waitForServer(PAGE_URLS.ONBOARDING);
        if (serverReady) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            window.loadURL(PAGE_URLS.ONBOARDING);
        }
        else {
            console.error('Failed to connect to Next.js server');
            app.quit();
            return;
        }
        // window.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        window.loadURL(PAGE_URLS.ONBOARDING);
    }
    // 窗口关闭事件
    window.on('closed', () => {
        context.setWindow(null);
        context.setWindowType(null);
    });
    // 设置引导窗口的简化菜单（与登录窗口相同）
    setupLoginMenu();
}
