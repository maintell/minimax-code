import { buildMavisSessionAdapter, createRemoteSessionReader, toAgentMessages, } from '../../../service/session-system/index.js';
import { managedBackendRoutingHeaders } from '../../../infra/config/routing-headers.js';
/** 每个 Host 一个远端会话读取器：路由表要跨 Turn 保留。 */
const remoteSessionReaders = new WeakMap();
function hostRemoteSessions(host) {
    let reader = remoteSessionReaders.get(host);
    if (!reader) {
        reader = createRemoteSessionReader({
            login: {
                authContextGetter: host.authContextGetter ?? (() => undefined),
                authContextInvalidator: host.authContextInvalidator,
                // The v2 wrapper reads MAVIS_BUILD_ENV; the agent-tools helper sends no lane without it.
                routingHeadersGetter: () => managedBackendRoutingHeaders(host.routingContextGetter?.()),
                fetchImpl: host.fetchImpl,
            },
            ...(host.remoteSessionHost ? { host: host.remoteSessionHost } : {}),
        });
        remoteSessionReaders.set(host, reader);
    }
    return reader;
}
/** Session 工具共用 Host 的等待图，消息和生命周期均进入同一 Conversation owner。 */
export function buildHostMavisSessionAdapter(host, conversation, serializers) {
    return buildMavisSessionAdapter({
        remoteSessions: hostRemoteSessions(host),
        ...(host.metricsClient ? { metrics: host.metricsClient } : {}),
        conversation,
        sessionSendWaitGraph: host.sessionSendWaitGraph,
        subSessionRoundAttribution: () => host.subSessionRoundAttribution,
        ...(host.composerSendBehavior ? { getComposerSendBehavior: host.composerSendBehavior } : {}),
        listAllSessions: (agentName, options) => host.listAllSessions(agentName, options),
        getSessionById: (sessionId) => host.getSessionById(sessionId),
        ...serializers,
        updateSession: (sessionId, fields) => conversation.lifecycle.updateSession(sessionId, fields),
        listDisplayMessages: async (sessionId, options) => {
            const page = await conversation.query.listMessages(sessionId, options);
            return {
                messages: toAgentMessages(page.messages),
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        },
    });
}
//# sourceMappingURL=host-session-adapter.js.map