import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { toConversationCommittedMessage } from '../../session-system/index.js';
import { resolveChannelRoute } from './routing.js';
/**
 * Best-effort terminal observer for Channel-sourced Turns.
 *
 * The Agent event pipeline only selects a durable terminal boundary. Actual
 * Channel routing and transport delivery stay behind an injected product
 * capability.
 */
export class ChannelFinalReplyObserver {
    options;
    constructor(options) {
        this.options = options;
    }
    async observeRuntimeEvent(input) {
        const status = terminalStatus(input.event);
        if (!status)
            return;
        try {
            await this.deliverTerminal(input.context, input.event, status);
        }
        finally {
            await this.options.turnLifecycle.end(input.context);
        }
    }
    async deliverTerminal(context, event, status) {
        const route = await this.resolveReplyChannel(context);
        if (!route)
            return;
        const [messages, session] = await Promise.all([
            this.options.messages.listTurn(context.sessionId, context.turnId),
            this.options.sessions.get(context.sessionId),
        ]);
        if (status !== 'failed' && !messages.some(isAssistantReply))
            return;
        const error = status === 'failed' ? terminalError(event) : undefined;
        await this.options.delivery.deliver({
            channelContext: route,
            sessionId: context.sessionId,
            messages: messages.map(toConversationCommittedMessage),
            ...(session ? { workspaceDir: session.workspaceDir } : {}),
            ...(error ? { error } : {}),
        });
    }
    async resolveReplyChannel(context) {
        let route = resolveChannelRoute(context.provenance) ??
            (await this.resolvePersistedTurnChannel(context.sessionId, context.turnId));
        // A retry has a fresh Turn id and no new user message. Resolve only the
        // original input selected by continuation, not an unrelated earlier IM.
        const continuedFromTurnId = context.provenance?.sourceContext?.continuedFromTurnId;
        if (!route &&
            context.provenance?.source === 'turn-continuation' &&
            typeof continuedFromTurnId === 'string') {
            route = await this.resolvePersistedTurnChannel(context.sessionId, continuedFromTurnId);
        }
        return route;
    }
    /**
     * Routing from the Turn's first persisted user message. It stays readable
     * for the whole Turn, so IM ingress uses the same answer to decide whether
     * a follow-up may join the running Turn.
     */
    async resolvePersistedTurnChannel(sessionId, turnId) {
        const persisted = await this.options.messages.resolveTurnSource(sessionId, turnId);
        return resolveChannelRoute(persisted);
    }
}
function terminalStatus(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return undefined;
    }
    if (event.payload.status === RuntimeEventStatus.COMPLETED)
        return 'completed';
    if (event.payload.status === RuntimeEventStatus.FAILED)
        return 'failed';
    return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}
function terminalError(event) {
    const error = event.payload.error?.message?.trim();
    if (error)
        return error;
    const stopReason = event.payload.stop_reason?.message?.trim();
    return stopReason || 'Turn failed';
}
function isAssistantReply(message) {
    return message.role === 'assistant';
}
//# sourceMappingURL=channel-final-reply-observer.js.map