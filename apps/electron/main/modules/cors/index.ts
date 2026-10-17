/**
 * CORS 处理模块
 * 通过 webRequest 拦截请求，解决 app:// 协议下的跨域问题
 */
import { session } from "electron";
import { getStandardUserAgent } from "../../utils/tool";
/**
 * 从 URL 中提取 Origin（协议 + 主机名）
 */
function getOriginFromUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}`;
    }
    catch {
        return '';
    }
}
/**
 * 设置 CORS 拦截器
 * 处理 app:// 协议下发起的跨域请求
 */
export function setupCorsHandler() {
    const filter = {
        urls: [
            'https://agent.minimax.io',
            'https://agent.minimaxi.com',
            'https://agent.minimax.cn',
            'https://chat.minimax.io',
            'https://chat.minimaxi.com',
            'https://matrix-test.xaminim.com',
            'https://matrix-overseas-test.xaminim.com',
            'https://matrix-pre.xaminim.com',
            'https://matrix-overseas-pre.xaminim.com',
            'https://hiloai-test.xaminim.com',
            'https://chat-pre.xaminim.com',
            'https://account-test.xaminim.com',
            'https://account-overseas-test.xaminim.com',
            'https://account-pre.xaminim.com',
            'https://account-overseas-pre.xaminim.com',
            'https://account.minimaxi.com',
            'https://account.minimax.cn',
            'https://account.minimax.io',
        ].map((url) => `${url}/*`),
    };
    // 拦截请求头，修改 Origin 和 User-Agent
    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        const { requestHeaders } = details;
        // 从请求 URL 提取目标 Origin
        const targetOrigin = getOriginFromUrl(details.url);
        // 使用标准 Chrome User-Agent，避免被 Cloudflare 拦截
        requestHeaders['User-Agent'] = getStandardUserAgent();
        // 设置 Referer 和 Origin 为请求的目标域名
        requestHeaders['Referer'] = targetOrigin + '/';
        requestHeaders['Origin'] = targetOrigin;
        callback({ requestHeaders });
    });
    // 拦截响应头，添加 CORS 头（如果不存在）
    session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        delete responseHeaders['access-control-allow-origin'];
        delete responseHeaders['access-control-allow-headers'];
        delete responseHeaders['access-control-allow-methods'];
        delete responseHeaders['access-control-allow-credentials'];
        // B. 重新注入“允许一切”的头，或者专门允许 'app://.'
        // 注意：Electron 中 header key 建议全小写（虽然标准不区分，但有时会有坑）
        responseHeaders['access-control-allow-origin'] = ['app://.']; // 核心：允许你的 electron 协议
        responseHeaders['access-control-allow-headers'] = ['*'];
        responseHeaders['access-control-allow-methods'] = ['GET, POST, PUT, DELETE, OPTIONS'];
        responseHeaders['access-control-allow-credentials'] = ['true'];
        callback({
            responseHeaders,
            // 核心：强制覆写状态码
            // 如果 OPTIONS 请求因为服务端不认识 app:// 返回了 403/400，
            // 我们在浏览器层欺骗它说 "这是个 200 OK"，浏览器就会放行后续请求。
            statusLine: details.method === 'OPTIONS' ? 'HTTP/1.1 200 OK' : details.statusLine,
        });
    });
}
