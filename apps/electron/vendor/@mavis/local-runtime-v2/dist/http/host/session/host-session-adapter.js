import { CloudSessionReader, managedBackendRoutingHeaders } from '@mavis/agent-tools/desktop';
import { buildMavisSessionAdapter, toAgentMessages, } from '../../../service/session-system/index.js';
/** Session 工具共用 Host 的等待图，消息和生命周期均进入同一 Conversation owner。 */
export function buildHostMavisSessionAdapter(host, conversation, serializers) {
    return buildMavisSessionAdapter({
        cloudReader: new CloudSessionReader({
            authContextGetter: host.authContextGetter ?? (() => undefined),
            authContextInvalidator: host.authContextInvalidator,
            routingHeadersGetter: () => managedBackendRoutingHeaders(host.routingContextGetter?.()),
            fetchImpl: host.fetchImpl,
        }),
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