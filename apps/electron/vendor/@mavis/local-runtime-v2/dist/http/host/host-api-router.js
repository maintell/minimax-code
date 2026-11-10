import { routeLocalPermissionApi, } from '../../service/permission/index.js';
import { routeLocalContentSafetyApi } from '../../service/content-safety/index.js';
import { routeLocalBrowserApi } from '../../service/browser-use/index.js';
import { routeLocalMatrixApi } from '../../service/matrix/index.js';
import { routeLocalFileApi, } from '../../service/workspace/index.js';
import { routeLocalCommunicationApi, routeLocalUsageSummaryApi, } from '../../service/session-system/index.js';
import { json, notFound, readJsonBody, splitPath } from '../../infra/transport/host-http.js';
import { routeDiagnosticsApi } from './host-helpers.js';
import { buildLocalLegacyMigrationCheck, buildLocalRuntimeStatus, routeLocalRuntimeCronApi, } from './host-support.js';
import { readBooleanSearchParam } from './session/host-agent-paging.js';
import { routeLocalConfigApi } from './routes/config.js';
import { routeLocalModelApi } from './routes/models.js';
import { routeLocalWebsiteSettingsApi } from './routes/website-settings.js';
import { mayHaveSetAcceptEditsMode } from './session/host-model-helpers.js';
import { routeDebugPiHistoryJsonl, } from './turn/host-debug-pi-history-jsonl.js';
/** 兼容 HTTP 路由的分派边界；Team 和无 owner 的 Channel 不提供执行入口。 */
export async function routeHostApi(host, request, apiPath, url) {
    const parts = splitPath(apiPath);
    if (!host.channelCapabilityEnabled && isChannelCapabilityRoute(parts))
        return notFound(apiPath);
    const input = { host, request, apiPath, url, parts, method: request.method.toUpperCase() };
    const runtimeResponse = await routeRuntimeApi(input);
    if (runtimeResponse)
        return runtimeResponse;
    const configurationResponse = await routeConfigurationApi(input);
    if (configurationResponse)
        return configurationResponse;
    const route = resourceRoutes.get(parts[0] ?? '');
    return (await route?.(input)) ?? notFound(apiPath);
}
async function routeRuntimeApi({ host, method, parts, url, }) {
    if (parts[0] !== 'runtime' || method !== 'GET')
        return undefined;
    switch (parts[1]) {
        case 'capabilities':
            return json({
                mode: host.runtimeMode,
                capabilities: host.capabilities,
                surfaces: host.surfaces,
            });
        case 'status':
            return json(buildLocalRuntimeStatus({
                runtimeMode: host.runtimeMode,
                runtimeOwnerKind: host.runtimeOwnerKind,
                capabilities: host.capabilities,
                surfaces: host.surfaces,
                config: host.configGetter(),
                runtimeStartupToken: host.runtimeStartupToken,
            }));
        case 'doctor':
            return json(host.getProcessLocalRuntimeDiagnostics());
        case 'migration':
            if (parts[2] !== 'check')
                return undefined;
            return json(await buildLocalLegacyMigrationCheck({
                runtimeMode: host.runtimeMode,
                dataDir: host.configGetter().dataDir,
                agentName: url.searchParams.get('agentName') ?? undefined,
                verbose: readBooleanSearchParam(url, 'verbose'),
                legacyMigrator: host.legacyMigrator,
            }));
        default:
            return undefined;
    }
}
async function routeConfigurationApi({ host, request, method, parts, url, }) {
    if (parts[0] === 'config' || parts.join('/') === 'external/llm-provider-discovery') {
        const response = await routeLocalConfigApi({
            configGetter: host.configGetter,
            configUpdater: host.configUpdater,
            publishGlobalEvent: host.publishGlobalEvent,
            permissionSeedRunner: async (body) => {
                if (mayHaveSetAcceptEditsMode(body))
                    await host.syncAcceptEditsSeed();
            },
        }, request, method, parts);
        if (response)
            return response;
    }
    return routeLocalModelApi({
        configGetter: host.configGetter,
        configUpdater: host.configUpdater,
        getSessionById: host.getSessionById,
        conversation: host.runtimeConversation,
        onDefaultModelChanged: () => { },
    }, { request, method, parts, url });
}
async function routeFileApi({ host, request, parts, url, }) {
    return routeLocalFileApi(request, parts, url, {
        metrics: host.metrics,
        gitChangesCoordinator: host.fileGitChangesCoordinator,
    });
}
async function routeAgentApi({ host, method, request, parts, url, }) {
    if (method === 'GET' && parts[1] === 'session' && parts[2]) {
        return host.agentRoutes.routeAgentSessionLookup(parts[2]);
    }
    if (method === 'POST' && parts.length === 1) {
        return host.agentRoutes.createLocalAgent(await readJsonBody(request));
    }
    if (parts[1] && parts.length > 2)
        return host.agentRoutes.routeAgentApi(request, parts, url);
    return undefined;
}
const resourceRoutes = new Map([
    [
        'permission',
        ({ host, method, request, parts, url }) => routeLocalPermissionApi(host.permissionRouteContext(), method, request, parts, url),
    ],
    [
        'content',
        ({ host, request, method, parts }) => routeLocalContentSafetyApi({
            safety: host.contentSafety,
            request,
            method,
            parts,
            configGetter: host.configGetter,
            authContextGetter: host.authContextGetter,
            routingContextGetter: host.routingContextGetter,
            fetch: host.fetchImpl,
        }),
    ],
    [
        'cron',
        ({ host, request, method, parts }) => routeLocalRuntimeCronApi({
            runtime: host.cronRuntime,
            listAllSessions: host.listAllSessions,
            method,
            request,
            parts,
        }),
    ],
    [
        'browser',
        ({ host, request, method, parts }) => routeLocalBrowserApi({ request, method, parts, broker: host.browserBroker }),
    ],
    [
        'matrix',
        ({ host, request, method, parts }) => routeLocalMatrixApi({
            request,
            method,
            parts,
            ...(host.authContextGetter ? { authContextGetter: host.authContextGetter } : {}),
            ...(host.routingContextGetter ? { routingContextGetter: host.routingContextGetter } : {}),
            fetchImpl: host.fetchImpl,
        }),
    ],
    [
        'diagnostics',
        ({ host, request, parts }) => routeDiagnosticsApi(host.hostDiagnosticsProvider, request, parts),
    ],
    [
        'debug',
        ({ host, method, parts }) => {
            if (method === 'GET' &&
                parts[1] === 'session' &&
                parts[2] &&
                parts[3] === 'pi-history.jsonl') {
                return routeDebugPiHistoryJsonl(host, parts[2]);
            }
            return undefined;
        },
    ],
    [
        'usage',
        ({ host, method, parts, url }) => {
            if (method === 'GET' && (parts.length === 1 || parts[1] === 'summary')) {
                return routeLocalUsageSummaryApi({ usageStore: host.tokenUsageStore, url });
            }
            return undefined;
        },
    ],
    [
        'drive',
        ({ host, request, method, parts }) => routeLocalWebsiteSettingsApi({
            request,
            method,
            parts,
            ...(host.authContextGetter ? { authContextGetter: host.authContextGetter } : {}),
            ...(host.routingContextGetter ? { routingContextGetter: host.routingContextGetter } : {}),
            ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
        }),
    ],
    ['file', routeFileApi],
    ['fs', routeFileApi],
    [
        'communication',
        ({ host, request, method, parts }) => routeLocalCommunicationApi({
            request,
            method,
            parts,
            nowMs: host.nowMs,
            getSessionById: host.getSessionById,
            listAllSessions: host.listAllSessions,
            communicationMessageStore: host.communicationMessageStore,
            ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
        }),
    ],
    ['agent', routeAgentApi],
    [
        'session',
        () => json({ error: 'Local Runtime V1 Conversation is unavailable' }, { status: 503 }),
    ],
]);
function isChannelCapabilityRoute(parts) {
    return (parts[0] === 'channel-bridge' ||
        parts[0] === 'im-bridge' ||
        parts[0] === 'channel-route' ||
        (parts[0] === 'channel' && parts[1] === 'connections') ||
        (parts[0] === 'lark' && parts[1] === 'onboard') ||
        (parts[0] === 'agent' && parts[2] === 'im'));
}
//# sourceMappingURL=host-api-router.js.map