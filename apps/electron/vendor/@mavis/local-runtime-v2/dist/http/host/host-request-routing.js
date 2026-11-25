/**
 * API request dispatch input assembled from `host.ts`, extracted so that file
 * stays inside the layout line budget.
 *
 * `routeHostApi` needs about forty host members. Most of them are public on
 * `LocalRuntimeApiHost` and are read straight off the host; the rest stay
 * private to the class and arrive through `HostRouteApiPrivateFields`, so no
 * field visibility has to be relaxed.
 */
import { resolveLocalPermissionService, } from '../../service/permission/index.js';
import { routeHostApi } from './host-api-router.js';
/** Everything `routeHostApi` reads off the host, including its derived values. */
export function buildHostRouteApiInput(host, privateFields) {
    return {
        runtimeMode: privateFields.runtimeMode,
        capabilities: privateFields.capabilities,
        surfaces: privateFields.surfaces,
        runtimeOwnerKind: privateFields.runtimeOwnerKind,
        runtimeStartupToken: privateFields.runtimeStartupToken,
        channelCapabilityEnabled: privateFields.channelCapabilityEnabled,
        configGetter: host.configGetter,
        configUpdater: host.configUpdater,
        ptcDefault: host.ptcDefault,
        authContextGetter: host.authContextGetter,
        routingContextGetter: host.routingContextGetter,
        fetchImpl: host.fetchImpl,
        hostDiagnosticsProvider: privateFields.hostDiagnosticsProvider,
        metrics: privateFields.metrics,
        metricsClient: host.metricsClient,
        nowMs: host.nowMs,
        communicationMessageStore: privateFields.communicationMessageStore,
        tokenUsageStore: privateFields.tokenUsageStore,
        runtimeConversation: host.runtimeConversation,
        coordinatorRoster: host.coordinatorRoster,
        legacyMigrator: privateFields.legacyMigrator,
        contentSafety: privateFields.contentSafety,
        cronRuntime: host.cronRuntime,
        browserBroker: privateFields.browserBroker,
        agentRoutes: host.agentRoutes,
        fileGitChangesCoordinator: privateFields.fileGitChangesCoordinator,
        getSessionById: (id) => host.getSessionById(id),
        listAllSessions: privateFields.listAllSessions,
        getPiHistory: (id) => host.getPiHistory(id),
        ensureLegacyPiHistoryMigrated: (id) => host.ensureLegacyPiHistoryMigrated(id),
        publishGlobalEvent: (event) => host.publishGlobalEvent(event),
        getProcessLocalRuntimeDiagnostics: () => host.getProcessLocalRuntimeDiagnostics(),
        permissionRouteContext: () => host.permissionRouteContext(),
        syncAcceptEditsSeed: () => resolveLocalPermissionService(privateFields.routeContextHost).syncAcceptEditsSeed(),
    };
}
//# sourceMappingURL=host-request-routing.js.map