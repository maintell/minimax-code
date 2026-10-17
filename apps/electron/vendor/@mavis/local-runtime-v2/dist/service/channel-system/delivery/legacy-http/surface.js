/**
 * The channel system's legacy HTTP delivery surface (proposal §7.2/§7.3).
 *
 * MR3: the v2 front door owns every legacy channel URL. This module builds
 * the ONE dispatch entry the front door mounts (`http/routing/channel-compat`
 * does URL recognition only) from the singleton subsystem instances, so the
 * old REST surface keeps its exact v1 wire behavior — same dispatchers, same
 * error mapping — without the request ever entering the v1 host.
 *
 * The error mapping in {@link dispatch} is a faithful port of the channel
 * slice of v1 `api/host-routing.ts` (`routeLocalRuntimeRequest` catch):
 * agent-contract errors, the primary-agent conflict contract and the
 * channel-client-unavailable contract keep their legacy JSON shapes; every
 * other throw stays a legacy-shaped 500 (`{ error: message }`), NOT the v2
 * `{code,key,message}` envelope.
 */
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
import { bindAgentDefaultChannelBinding } from '../../binding/default-channel-binding.js';
import { PRIMARY_AGENT_CHANNEL_CONFLICT, PrimaryAgentChannelConflictError, } from '../../binding/family-gate.js';
import { CHANNEL_CLIENT_UNAVAILABLE, LocalChannelClientUnavailableError, } from '../../ingress/runner.js';
import { isAgentContractLikeError } from './agent-contract-error.js';
import { routeLocalChannelBridgeInfraApi } from './dispatch/bridge-routes.js';
import { routeLocalChannelConnectionsApi } from './dispatch/connections-routes.js';
import { LocalFeishuOnboardService } from './platform-api/feishu-onboard-service.js';
import { json, notFound } from './http-helpers.js';
import { routeLocalChannelRouteApi } from './route-api.js';
/** Builds the legacy HTTP surface; one per subsystem, assembled exactly once. */
export function buildChannelLegacyHttpSurface(input) {
    const { subsystem, wire } = input;
    const infra = subsystem.channelBridgeInfra;
    const runner = subsystem.channelRunner;
    // The v2-owned interactive Lark onboarding service. Constructed here (not
    // in wire.ts) because it is purely a legacy HTTP facade concern; it shares
    // the subsystem's Api/stores so onboarding lands on the single owner.
    const feishuOnboardService = new LocalFeishuOnboardService({
        feishu: subsystem.feishuChannelApi,
        ...(wire.resolveAgentWriteTarget
            ? { resolveAgentWriteTarget: wire.resolveAgentWriteTarget }
            : {}),
        bindingStore: infra.bindingStore,
        ...(infra.imConnectionStore ? { imConnectionStore: infra.imConnectionStore } : {}),
        accessControlStore: subsystem.channelAccessControlStore,
        ...(infra.rootlessEnabled
            ? {
                bindRootlessDefaultSession: async (agentName) => {
                    await bindAgentDefaultChannelBinding(infra, 'feishu', agentName, agentName);
                },
            }
            : {
                ensureRootSession: async (agentName) => {
                    const sessions = (await wire.listSessions(agentName, {
                        includeHidden: true,
                    }));
                    const existing = sessions.find((session) => session.runtime === 'pi-agent' && session.sessionType === 'root');
                    if (existing)
                        return existing;
                    return (await wire.createRootSession(agentName));
                },
            }),
        nowMs: wire.nowMs,
        makeId: wire.makeId,
        fetchImpl: input.feishuOnboardFetch ?? wire.fetchImpl,
        ...(wire.metricsReporter ? { metrics: wire.metricsReporter } : {}),
    });
    const routeRecognized = async (routeInput) => {
        const { request, method, parts, url } = routeInput;
        if (parts[0] === 'channel' && parts[1] === 'connections') {
            // v1 host parity: the dispatcher answers every matched prefix itself
            // (it has its own legacy 404 for unknown sub-paths); the `??` arm is
            // defensive and mirrors the v1 host's dead `?? notFound(apiPath)`.
            return ((await routeLocalChannelConnectionsApi({
                request,
                method,
                parts,
                url,
                infra,
                feishu: subsystem.feishuChannelApi,
                telegram: subsystem.telegramChannelApi,
                wechat: subsystem.wechatChannelApi,
                cancelFeishuAuthorization: (connectionId) => feishuOnboardService.cancelAuthorizationForConnection(connectionId),
            })) ?? notFound(`/${parts.join('/')}`));
        }
        if (parts[0] === 'channel-bridge' || parts[0] === 'im-bridge') {
            return routeLocalChannelBridgeInfraApi({
                request,
                method,
                parts,
                url,
                infra,
                runner,
                feishu: subsystem.feishuChannelApi,
                telegram: subsystem.telegramChannelApi,
                wechat: subsystem.wechatChannelApi,
                feishuCardActionHandler: subsystem.feishuCardActionHandler,
            });
        }
        if (parts[0] === 'lark' && parts[1] === 'onboard') {
            return feishuOnboardService.route(request, method, [...parts], url);
        }
        if (parts[0] === 'channel-route') {
            return routeLocalChannelRouteApi({
                dataDir: wire.dataDir(),
                defaultAgentName: wire.agentName,
                request,
                method,
                parts,
                url,
                nowMs: wire.nowMs,
            });
        }
        return undefined;
    };
    const surface = {
        dispatch: async (routeInput) => {
            try {
                return await routeRecognized(routeInput);
            }
            catch (err) {
                // Faithful port of the v1 catch (api/host-routing.ts). Order matters:
                // the structural agent-contract check also matches v1-thrown
                // instances crossing the wire closures.
                if (isAgentContractLikeError(err)) {
                    const details = err.details;
                    logger.warn({ code: err.code, status: err.status, path: routeInput.parts.join('/') }, 'Channel legacy route rejected by the agent contract');
                    return json({ error: err.message, code: err.code, ...(details ?? {}) }, { status: err.status });
                }
                if (err instanceof PrimaryAgentChannelConflictError) {
                    logger.warn({ path: routeInput.parts.join('/') }, 'Channel legacy route hit the primary-agent binding conflict');
                    return json({
                        error: 'Primary Agent channel binding conflicts with an existing binding',
                        code: PRIMARY_AGENT_CHANNEL_CONFLICT,
                        status: 'conflict',
                    }, { status: 409 });
                }
                if (err instanceof LocalChannelClientUnavailableError) {
                    logger.warn({ path: routeInput.parts.join('/') }, 'Channel legacy route found no live channel client');
                    return json({ error: 'Channel client is unavailable', code: CHANNEL_CLIENT_UNAVAILABLE }, { status: 503 });
                }
                const message = err instanceof Error ? err.message : String(err);
                logger.error({ err, path: routeInput.parts.join('/'), stage: 'channel_legacy_http' }, 'Channel legacy route dispatch failed');
                return json({ error: message }, { status: 500 });
            }
        },
        ...(wire.resolveAgentReadScope ? { resolveAgentReadScope: wire.resolveAgentReadScope } : {}),
    };
    return { surface, feishuOnboardService };
}
//# sourceMappingURL=surface.js.map