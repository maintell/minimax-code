/**
 * Electron 页面路由配置
 * 根据环境自动选择正确的协议
 */

import { DEV_SERVER_URL, PROD_PROTOCOL } from "./constants";
import { isDev } from "./env";
/**
 * 页面路由定义
 */
export let ROUTES = {
    /** 登录页面 */
    LOGIN: '/login',
    /** 引导页面 */
    ONBOARDING: '/onboarding',
    /** Archon 小窗聊天页面 */
    ARCHON_MINI_CHAT: '/archon-mini-chat',
    /** 日志查看器页面 */
    LOG_VIEWER: '/log-viewer',
    /** Archon Chat 页面 */
    ARCHON_CHAT: '/archon',
};
/**
 * 根据环境获取完整的页面 URL
 * @param route - 路由路径
 * @returns 完整的 URL
 */
export function getPageURL(route) {
    if (isDev) {
        return `${DEV_SERVER_URL}${route}`;
    }
    // 生产环境：app://./settings -> 协议处理器会解析为 out/settings/index.html
    return `${PROD_PROTOCOL}${route.startsWith('/') ? route.slice(1) : route}`;
}
/**
 * 预定义的页面 URL
 */
export let PAGE_URLS = {
    get LOGIN() {
        return getPageURL(ROUTES.LOGIN);
    },
    get ONBOARDING() {
        return getPageURL(ROUTES.ONBOARDING);
    },
    get ARCHON_MINI_CHAT() {
        return getPageURL(ROUTES.ARCHON_MINI_CHAT);
    },
    get LOG_VIEWER() {
        return getPageURL(ROUTES.LOG_VIEWER);
    },
    get ARCHON_CHAT() {
        return getPageURL(ROUTES.ARCHON_CHAT);
    },
};
