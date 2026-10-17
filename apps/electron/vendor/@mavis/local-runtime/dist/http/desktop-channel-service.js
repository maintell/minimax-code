import { HTTPException } from 'hono/http-exception';
import { logger } from '../common/logger.js';
import { DesktopServiceMemoryBase } from './desktop-memory-service-base.js';
import { jsonError } from './desktop-service-support.js';
const LOCAL_RUNTIME_ORIGIN = 'http://local-runtime.test';
const LOCAL_API_BASE = `${LOCAL_RUNTIME_ORIGIN}/mavis/api/`;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
/**
 * Desktop channel surface (IM MR3).
 *
 * The Channel owner lives in Local Runtime V2: hosts that compose it serve
 * the 15 generated channel methods from the v2 controller, so requests never
 * reach this class there. On hosts WITHOUT the owner (embedded CLI/TUI,
 * standalone v1) the methods below answer the same stable legacy 404 the
 * old local-API forwarding produced once the v1 channel routes were gone —
 * byte-identical `{error: "Local runtime route not found: <route>"}` bodies,
 * where `<route>` is the first legacy route each old forward would have hit.
 *
 * This class also remains the home of the in-process local-API transport
 * (`localApiJson` / `localApiResponse`) shared by the Session/Questionnaire
 * desktop services — that transport is generic and stays.
 */
export class DesktopChannelServiceBase extends DesktopServiceMemoryBase {
    listChannelConnections(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/channel/connections');
    }
    prepareChannelConnection(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/channel/connections/prepare');
    }
    disconnectChannelConnection(ctx, req) {
        void ctx;
        return this.channelRouteGone(`/channel/connections/${req.connectionId}/binding`);
    }
    deleteChannelConnection(ctx, req) {
        void ctx;
        return this.channelRouteGone(`/channel/connections/${req.connectionId}`);
    }
    cancelChannelAuthorization(ctx, req) {
        void ctx;
        return this.channelRouteGone(`/channel/connections/${req.connectionId}/authorization/cancel`);
    }
    listChannelBindings(ctx, req) {
        void ctx;
        void req;
        // The old mapping's first legacy call was the bridge status snapshot.
        return this.channelRouteGone('/channel-bridge/status');
    }
    unbindChannel(ctx, req) {
        void ctx;
        const id = (req.bindingId ?? '').trim();
        const platform = id.startsWith('wechat:')
            ? 'wechat'
            : id.startsWith('telegram:')
                ? 'telegram'
                : 'feishu';
        return this.channelRouteGone(`/channel-bridge/${platform}/unbind`);
    }
    updateChannelBindingTarget(ctx, req) {
        void ctx;
        void req;
        // The old mapping resolved the physical binding via the Connection view first.
        return this.channelRouteGone('/channel/connections');
    }
    bindTelegram(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/channel-bridge/telegram/bind');
    }
    startWechatBind(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/channel-bridge/wechat/bind/start');
    }
    getWechatBindStatus(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/channel-bridge/wechat/bind/status');
    }
    bindFeishu(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/channel-bridge/feishu/bind');
    }
    startLarkOnboard(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/lark/onboard/start');
    }
    getLarkOnboardStatus(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/lark/onboard/status');
    }
    cancelLarkOnboard(ctx, req) {
        void ctx;
        void req;
        return this.channelRouteGone('/lark/onboard/cancel');
    }
    /**
     * Stable no-IM contract of this host class: the same legacy 404 body a
     * channel local-API call produces on a v1 router without channel routes.
     * Logged so a mis-composed owner host (v2 controller not mounted) is
     * diagnosable from the access log instead of silently 404ing.
     */
    channelRouteGone(route) {
        logger.info({ route, mode: 'no-im' }, 'Desktop channel method answered by the no-IM stub (channel owner not composed on this host)');
        throw new HTTPException(404, {
            res: new Response(JSON.stringify({ error: `Local runtime route not found: ${route}` }), {
                status: 404,
                headers: JSON_HEADERS,
            }),
        });
    }
    /**
     * In-process local-API transport shared by DesktopSessionService and the
     * questionnaire desktop service. Generic (not channel-specific) and kept
     * byte-identical to the pre-MR3 implementation: `localApiJson` throws the
     * legacy Response verbatim on non-2xx, `localApiResponse` returns non-ok
     * responses to the caller and only logs them.
     */
    async localApiJson(pathOrUrl, init = {}) {
        const response = await this.localApiResponse(pathOrUrl, init);
        if (!response.ok) {
            throw new HTTPException(response.status, { res: response });
        }
        if (response.status === 204)
            return {};
        const text = await response.text();
        if (!text)
            return {};
        return JSON.parse(text);
    }
    async localApiResponse(pathOrUrl, init = {}) {
        const route = this.getLocalApiRoute();
        if (!route) {
            throw new HTTPException(503, {
                res: jsonError(503, 'Local session API is not available', 'SESSION_API_UNAVAILABLE'),
            });
        }
        const url = typeof pathOrUrl === 'string'
            ? pathOrUrl.startsWith('/mavis/api/')
                ? new URL(pathOrUrl, LOCAL_RUNTIME_ORIGIN)
                : new URL(pathOrUrl.replace(/^\/+/, ''), LOCAL_API_BASE)
            : pathOrUrl;
        const method = init.method ?? 'GET';
        const request = new Request(url, {
            method,
            ...(init.signal ? { signal: init.signal } : {}),
            ...(init.body !== undefined
                ? { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } }
                : {}),
        });
        const startedAt = Date.now();
        const logPath = redactLocalApiLogPath(url.pathname);
        try {
            const response = await route(request);
            logger.info({
                method,
                path: logPath,
                status: response.status,
                duration_ms: Date.now() - startedAt,
                error_code: response.ok ? undefined : await readLocalApiErrorCode(response),
            }, 'desktop channel local runtime route');
            return response;
        }
        catch (err) {
            logger.warn({
                method,
                path: logPath,
                status: 'throw',
                duration_ms: Date.now() - startedAt,
                error_code: err instanceof Error ? err.name : 'UNKNOWN_ERROR',
            }, 'desktop channel local runtime route failed');
            throw err;
        }
    }
}
/** Never log raw binding keys (they embed chat/sender coordinates). */
function redactLocalApiLogPath(pathname) {
    return /^\/mavis\/api\/channel-bridge\/bindings\/[^/]+\/target$/u.test(pathname)
        ? '/mavis/api/channel-bridge/bindings/:bindingId/target'
        : pathname;
}
/** Best-effort structured error code for the access log (body untouched). */
async function readLocalApiErrorCode(response) {
    try {
        const body = (await response.clone().json());
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return undefined;
        const code = body.code;
        return typeof code === 'string' && code.length > 0 ? code : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=desktop-channel-service.js.map