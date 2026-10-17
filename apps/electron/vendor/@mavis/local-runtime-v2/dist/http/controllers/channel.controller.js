// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
// Regeneration never overwrites an existing controller file.
import { HTTPException } from 'hono/http-exception';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { ChannelControllerBase } from '../generated/channel-controller-base.gen.js';
import { ChannelApplication } from '../../application/channel/channel-application.js';
import { isChannelWireError } from '../../application/channel/wire-error.js';
const LOCAL_RUNTIME_ORIGIN = 'http://local-runtime.test';
const LEGACY_JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
/**
 * The 15 generated channel methods over the Channel Application (MR3 A).
 *
 * The controller owns the two HTTP edges the application layer must not
 * touch: (1) the gateway — in-process Requests against the channel system's
 * `legacyHttp.dispatch`, the SAME entry the legacy REST mount uses, with the
 * v1 per-call access log; (2) wire-error serialization — a thrown
 * {@link ChannelWireError} becomes its legacy body verbatim, never the v2
 * `{code,key,message}` envelope (the UI parses `{error, code}`).
 */
class ReadyChannelController extends ChannelControllerBase {
    application;
    constructor(surface) {
        super();
        const resolveAgentReadScope = surface.resolveAgentReadScope?.bind(surface);
        this.application = new ChannelApplication({
            gateway: buildChannelLegacyGateway(surface),
            ...(resolveAgentReadScope ? { agentResolver: { resolveAgentReadScope } } : {}),
        });
    }
    listChannelBindings(ctx, req) {
        void ctx;
        return this.run(() => this.application.listChannelBindings(req));
    }
    listChannelConnections(ctx, req) {
        void ctx;
        return this.run(() => this.application.listChannelConnections(req));
    }
    prepareChannelConnection(ctx, req) {
        void ctx;
        return this.run(() => this.application.prepareChannelConnection(req));
    }
    disconnectChannelConnection(ctx, req) {
        void ctx;
        return this.run(() => this.application.disconnectChannelConnection(req));
    }
    deleteChannelConnection(ctx, req) {
        void ctx;
        return this.run(() => this.application.deleteChannelConnection(req));
    }
    cancelChannelAuthorization(ctx, req) {
        void ctx;
        return this.run(() => this.application.cancelChannelAuthorization(req));
    }
    unbindChannel(ctx, req) {
        void ctx;
        return this.run(() => this.application.unbindChannel(req));
    }
    updateChannelBindingTarget(ctx, req) {
        void ctx;
        return this.run(() => this.application.updateChannelBindingTarget(req));
    }
    bindTelegram(ctx, req) {
        void ctx;
        return this.run(() => this.application.bindTelegram(req));
    }
    startWechatBind(ctx, req) {
        void ctx;
        return this.run(() => this.application.startWechatBind(req));
    }
    getWechatBindStatus(ctx, req) {
        void ctx;
        return this.run(() => this.application.getWechatBindStatus(req));
    }
    bindFeishu(ctx, req) {
        void ctx;
        return this.run(() => this.application.bindFeishu(req));
    }
    startLarkOnboard(ctx, req) {
        void ctx;
        return this.run(() => this.application.startLarkOnboard(req));
    }
    getLarkOnboardStatus(ctx, req) {
        void ctx;
        return this.run(() => this.application.getLarkOnboardStatus(req));
    }
    cancelLarkOnboard(ctx, req) {
        void ctx;
        return this.run(() => this.application.cancelLarkOnboard(req));
    }
    /** Serializes wire errors verbatim (v1 HTTPException-with-res parity). */
    async run(operation) {
        try {
            return await operation();
        }
        catch (err) {
            if (isChannelWireError(err)) {
                throw new HTTPException(err.status, {
                    res: new Response(JSON.stringify(err.body), {
                        status: err.status,
                        headers: LEGACY_JSON_HEADERS,
                    }),
                });
            }
            throw err;
        }
    }
}
/**
 * In-process gateway over the single legacy dispatch surface. Path/parts
 * semantics and the access log mirror v1 `localApiResponse`, so the mapping
 * behaves identically whether a caller uses the generated method or the
 * legacy REST route.
 */
function buildChannelLegacyGateway(surface) {
    return {
        request: async (path, init) => {
            const url = new URL(path, LOCAL_RUNTIME_ORIGIN);
            const method = init?.method ?? 'GET';
            const request = new Request(url, {
                method,
                ...(init?.body !== undefined
                    ? { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } }
                    : {}),
            });
            const parts = decodeURIComponent(url.pathname)
                .replace(/^\/mavis\/api/u, '')
                .split('/')
                .filter(Boolean);
            const startedAt = Date.now();
            const logPath = redactChannelGatewayLogPath(url.pathname);
            let response;
            try {
                response = await surface.dispatch({ request, method, parts, url });
            }
            catch (err) {
                logger.warn({
                    method,
                    path: logPath,
                    status: 'throw',
                    duration_ms: Date.now() - startedAt,
                    error_code: err instanceof Error ? err.name : 'UNKNOWN_ERROR',
                }, 'desktop channel gateway dispatch failed');
                throw err;
            }
            if (!response) {
                // Unreachable for channel paths; loud legacy 404 instead of silence.
                logger.error({ method, path: logPath, stage: 'channel_gateway' }, 'Channel gateway path was not recognized by the legacy surface');
                return {
                    status: 404,
                    ok: false,
                    bodyText: JSON.stringify({
                        error: `Local runtime route not found: /${parts.join('/')}`,
                    }),
                };
            }
            const bodyText = await response.text();
            logger.info({
                method,
                path: logPath,
                status: response.status,
                duration_ms: Date.now() - startedAt,
                error_code: response.ok ? undefined : errorCodeFromBody(bodyText),
            }, 'desktop channel local runtime route');
            return { status: response.status, ok: response.ok, bodyText };
        },
    };
}
/** v1 `redactLocalApiLogPath` twin: never log raw binding keys. */
function redactChannelGatewayLogPath(pathname) {
    return /^\/mavis\/api\/channel-bridge\/bindings\/[^/]+\/target$/u.test(pathname)
        ? '/mavis/api/channel-bridge/bindings/:bindingId/target'
        : pathname;
}
function errorCodeFromBody(bodyText) {
    try {
        const body = JSON.parse(bodyText);
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return undefined;
        const code = body.code;
        return typeof code === 'string' && code.length > 0 ? code : undefined;
    }
    catch {
        return undefined;
    }
}
/** Ready-host factory: hosts with the composed channel owner mount this. */
export function createChannelController(surface) {
    return new ReadyChannelController(surface);
}
/** Fallback stub for hosts without the channel owner (never allowlisted). */
export const channelController = new ChannelControllerBase();
//# sourceMappingURL=channel.controller.js.map