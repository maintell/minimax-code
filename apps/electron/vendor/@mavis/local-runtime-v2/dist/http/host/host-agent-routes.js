/**
 * Agent route composition extracted from `host.ts` to keep that file inside the
 * layout line budget.
 *
 * The route context reads about twenty host members. Most are public on
 * `LocalRuntimeApiHost` and arrive through `HostAgentRoutesSurface`; the ones
 * that stay private to the class arrive through
 * `HostAgentRoutesPrivatePorts`, so no field visibility has to be relaxed.
 */
import { resolveLocalRuntimeLocale } from '../../infra/config/locale.js';
import { LocalApiAgentRoutes } from './routes/agents.js';
import { requestConversationCompaction } from './routes/compaction.js';
import { isReadOnlyLegacySession, markMigratedLegacySessionDeleted, } from './session/host-legacy-helpers.js';
import { hostNormalizeCleanLocalSession, hostSerializeSession, hostSerializeSessions, hostSerializeSessionTree, } from './session/host-session-state.js';
/** The Session state view the serializers read. */
export function buildHostSessionStateHandle(host, legacyMigrator) {
    return {
        configGetter: () => ({ ...host.configGetter() }),
        legacyMigrator,
        readSessionPinned: host.readSessionPinned,
        getSessionById: (id) => host.getSessionById(id),
    };
}
/** Agent identity, Session listing and IM routes for this Runtime. */
export function createHostAgentRoutes(host, privatePorts) {
    return new LocalApiAgentRoutes({
        controller: host.controller,
        ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
        agentRuntimePort: host.agentRuntimePort,
        legacyMigrator: privatePorts.legacyMigrator,
        runtimeMode: privatePorts.runtimeMode,
        agentName: host.agentName,
        agentDisplayName: host.agentDisplayName,
        configGetter: host.configGetter,
        nowMs: host.nowMs,
        resolveDefaultWorkspaceDir: () => host.resolveDefaultWorkspaceDir(),
        getLegacyRuntime: () => privatePorts.getLegacyRuntime(),
        getSessionById: (id) => host.getSessionById(id),
        listAllSessions: (a, o) => host.listAllSessions(a, o),
        serializeSessions: (s) => hostSerializeSessions(privatePorts.sessionStateHost(), s),
        serializeSessionTree: (sessions, url, agentName, getSessionById) => hostSerializeSessionTree(privatePorts.sessionStateHost(), sessions, {
            url,
            agentName,
            getSessionById,
        }),
        serializeSession: (s) => hostSerializeSession(privatePorts.sessionStateHost(), s),
        isReadOnlyLegacySession: (s) => isReadOnlyLegacySession(privatePorts.legacyMigrator, s),
        markMigratedLegacySessionDeleted: (id) => markMigratedLegacySessionDeleted(privatePorts.legacyMigrator, id),
        requestCompaction: (s, b) => requestConversationCompaction(privatePorts.requireRuntimeConversation('Session compaction'), s, b),
        abortLocalSessionTurn: (id) => privatePorts.abortLocalSessionTurn(id),
        normalizeCleanLocalSession: (s) => hostNormalizeCleanLocalSession(privatePorts.sessionStateHost(), s),
        publishGlobalEvent: (event) => host.publishGlobalEvent(event),
        ...(privatePorts.channelCapabilityEnabled
            ? {
                routeAgentIm: (a, m) => host.requireChannelPort('agent IM routes').routeAgentIm(a, m),
                getAgentChannelConfig: (a) => host.requireChannelPort('agent channel config').buildAgentChannelConfig(a),
            }
            : {}),
        resolveLocale: () => resolveLocalRuntimeLocale(),
        metricsReporter: host.metrics,
    });
}
//# sourceMappingURL=host-agent-routes.js.map