import { MINIAPP_LOOPBACK_TOKEN_HEADER } from "@mavis/shared/miniapp-surface";
import { parseMiniAppLoopbackOrigin } from "./miniapp-loopback-origin";
// WebSocket handshakes carry the same credential; the child guard destroys
// unauthenticated upgrades.
const LOOPBACK_REQUEST_FILTER = { urls: ['http://127.0.0.1/*', 'ws://127.0.0.1/*'] };
/**
 * Adds the Host-issued loopback credential to requests that a registered Mini App
 * tab sends to its own origin. Other tabs, other origins, and unregistered
 * WebContents pass through unchanged.
 */
export function registerMiniAppLoopbackAuth(session, registry) {
    session.webRequest.onBeforeSendHeaders(LOOPBACK_REQUEST_FILTER, (details, callback) => {
        callback({ requestHeaders: miniAppLoopbackRequestHeaders(details, registry) });
    });
}
export function miniAppLoopbackRequestHeaders(details, registry) {
    const entry = typeof details.webContentsId === 'number' ? registry.get(details.webContentsId) : undefined;
    if (!entry || loopbackHttpOrigin(details.url) !== entry.origin)
        return details.requestHeaders;
    // Only the tab's top-level navigation or a frame already on the Mini App origin may send the
    // credential; a foreign iframe inside the page cannot borrow it.
    if (details.resourceType !== 'mainFrame' && requestingFrameOrigin(details) !== entry.origin) {
        return details.requestHeaders;
    }
    const requestHeaders = {};
    for (const [name, value] of Object.entries(details.requestHeaders)) {
        if (name.toLowerCase() !== MINIAPP_LOOPBACK_TOKEN_HEADER)
            requestHeaders[name] = value;
    }
    requestHeaders[MINIAPP_LOOPBACK_TOKEN_HEADER] = entry.token;
    return requestHeaders;
}
function requestingFrameOrigin(details) {
    try {
        return details.frame?.origin;
    }
    catch {
        // A frame disposed during the request has no provable origin.
        return undefined;
    }
}
function loopbackHttpOrigin(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'ws:')
            parsed.protocol = 'http:';
        if (parsed.protocol !== 'http:')
            return undefined;
        return parseMiniAppLoopbackOrigin(`${parsed.protocol}//${parsed.host}`)?.origin;
    }
    catch {
        return undefined;
    }
}
