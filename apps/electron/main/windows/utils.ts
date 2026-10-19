/**
 * 窗口工具函数
 * 提供窗口管理中常用的工具函数
 */
import { nativeTheme, BrowserWindow, screen } from "electron";
import { ALLOWED_OAUTH_DOMAINS } from "../config";
const TRANSPARENT_BACKGROUND_COLORS = new Set(['#00000000', 'transparent', 'rgba(0,0,0,0)']);
const transparentWindows = new WeakSet();
export let ARCHON_MACOS_TRAFFIC_LIGHT_POSITION = { x: 18, y: 16 };
/**
 * 获取标题栏样式
 * macOS 使用 hiddenInset，其他平台使用 default
 */
export function getTitleBarStyle(platform) {
    return platform === 'darwin' ? 'hiddenInset' : 'default';
}
/**
 * 获取窗口背景颜色
 * 根据当前 native theme 返回深色或浅色背景
 */
export function getBackgroundColor(shouldUseDarkColors = nativeTheme.shouldUseDarkColors) {
    return shouldUseDarkColors ? '#1a1a1a' : '#ffffff';
}
/**
 * Electron 的 getBackgroundColor() 会丢失透明通道，因此透明窗口需要在创建时明确登记。
 */
export function registerTransparentWindow(window) {
    transparentWindows.add(window);
}
/**
 * 将当前 native theme 的背景色同步到已有窗口
 */
export function shouldSyncWindowBackgroundColor(window) {
    if (transparentWindows.has(window))
        return false;
    const normalizedBackgroundColor = window.getBackgroundColor().replace(/\s+/gu, '').toLowerCase();
    return !TRANSPARENT_BACKGROUND_COLORS.has(normalizedBackgroundColor);
}
export function syncWindowBackgroundColors() {
    const backgroundColor = getBackgroundColor();
    for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && shouldSyncWindowBackgroundColor(window)) {
            window.setBackgroundColor(backgroundColor);
        }
    }
}
/**
 * 验证是否为允许的 OAuth 域名
 * 使用严格的域名匹配，防止子域名注入攻击
 */
export function isAuthUrl(url, allowedDomains = ALLOWED_OAUTH_DOMAINS) {
    try {
        const parsedUrl = new URL(url);
        return allowedDomains.some((domain) => parsedUrl.host === domain || parsedUrl.host.endsWith(`.${domain}`));
    }
    catch {
        return false;
    }
}
/**
 * 处理窗口打开请求
 * 返回是否应该拒绝打开（http/https 链接会被拒绝，由外部浏览器打开）
 */
export function shouldDenyWindowOpen(url) {
    return url.startsWith('http://') || url.startsWith('https://');
}
/**
 * 安全销毁窗口
 * 检查窗口是否存在且未被销毁后再销毁
 */
export function destroyWindow(window) {
    if (window && !window.isDestroyed()) {
        window.destroy();
    }
}
/**
 * 默认的安全 Web 首选项
 */
export let DEFAULT_SECURE_WEB_PREFERENCES = {
    nodeIntegration: false,
    contextIsolation: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
};
/**
 * 获取窗口在当前鼠标所在屏幕的居中偏下位置
 */
export function getWindowPositionForCurrentDisplay(windowWidth, windowHeight) {
    const cursorPoint = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const { x: workX, y: workY, width, height } = currentDisplay.workArea;
    const x = workX + Math.round((width - windowWidth) / 2);
    const y = workY + height - windowHeight - 50;
    return { x, y };
}
