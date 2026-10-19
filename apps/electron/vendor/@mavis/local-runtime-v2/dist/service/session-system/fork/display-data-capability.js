import { resolveForkDisplayBoundary } from './display-boundary.js';
import { resolveSideHistoryBoundary } from './side-history-boundary.js';
/** Session-owned Display boundary and projection operations used by Application Fork. */
export function createSessionForkDisplayCapability(messages, historyMutation) {
    return {
        list: async (sessionId) => (await messages.list(sessionId)).messages,
        boundary: {
            resolve: async ({ sessionId, assistantDisplayMessageId, sideHistory, }) => {
                const display = (await messages.list(sessionId)).messages;
                const boundary = resolveForkDisplayBoundary(display, assistantDisplayMessageId);
                if (!boundary.assistant || boundary.assistantIndex < 0)
                    return undefined;
                if (sideHistory) {
                    const history = await historyMutation.read(sessionId);
                    const messageId = resolveSideHistoryBoundary(history, sideHistory.throughMessageId);
                    return {
                        messages: display,
                        assistant: boundary.assistant,
                        assistantIndex: boundary.assistantIndex,
                        isLatestConversationMessage: boundary.isLatestConversationMessage,
                        canonicalBoundaryReachable: messageId !== undefined,
                        ...(messageId ? { sideHistoryMessageId: messageId } : {}),
                    };
                }
                const candidates = [
                    boundary.assistantCanonicalMessageId,
                    boundary.beforeUserMessageId,
                ].filter((candidate) => Boolean(candidate));
                const history = candidates.length > 0 ? await historyMutation.read(sessionId) : undefined;
                const canonical = resolveCanonicalBoundary(history, boundary);
                return {
                    messages: display,
                    assistant: boundary.assistant,
                    assistantIndex: boundary.assistantIndex,
                    canonicalBoundaryReachable: candidates.length === 0 || canonical.reachable,
                    isLatestConversationMessage: boundary.isLatestConversationMessage,
                    ...(canonical.assistantMessageId
                        ? { assistantCanonicalMessageId: canonical.assistantMessageId }
                        : {}),
                    ...(canonical.beforeUserMessageId
                        ? { beforeUserMessageId: canonical.beforeUserMessageId }
                        : {}),
                };
            },
        },
        probePrefix: (input) => probeDisplayPrefix(messages, input),
        copyPrefix: (input) => messages.copyPrefix(input),
        copyPrefixAndAppendForkOrigin: (input) => messages.copyPrefixAndAppendForkOrigin(input),
        appendForkOrigin: (input) => messages.appendForkOrigin(input),
        latestRevision: (sessionId) => messages.latestDisplayRowId(sessionId),
        deleteSession: (sessionId) => messages.deleteSessionData(sessionId),
    };
}
function resolveCanonicalBoundary(history, boundary) {
    if (hasCanonicalBoundary(history, boundary.assistantCanonicalMessageId)) {
        return {
            reachable: true,
            assistantMessageId: boundary.assistantCanonicalMessageId,
            beforeUserMessageId: undefined,
        };
    }
    if (hasCanonicalBoundary(history, boundary.beforeUserMessageId)) {
        return {
            reachable: true,
            assistantMessageId: undefined,
            beforeUserMessageId: boundary.beforeUserMessageId,
        };
    }
    return {
        reachable: false,
        assistantMessageId: boundary.assistantCanonicalMessageId,
        beforeUserMessageId: boundary.assistantCanonicalMessageId
            ? undefined
            : boundary.beforeUserMessageId,
    };
}
function hasCanonicalBoundary(history, messageId) {
    if (!history || !messageId)
        return false;
    return (history.active.some((envelope) => envelope.message_id === messageId) ||
        history.snapshots.some((snapshot) => snapshot.records.some((envelope) => envelope.message_id === messageId)));
}
async function probeDisplayPrefix(messages, input) {
    const [source, target] = await Promise.all([
        messages.list(input.sourceSessionId),
        messages.list(input.targetSessionId),
    ]);
    const through = source.messages.findIndex((message) => message.msg_id === input.throughMessageId);
    if (through < 0)
        return false;
    const prefix = source.messages.slice(0, through + 1).filter((message) => !isForkOrigin(message));
    const copied = target.messages.slice(0, prefix.length);
    if (copied.length !== prefix.length ||
        copied.some((message, index) => message.msg_id !== prefix[index]?.msg_id)) {
        return false;
    }
    return target.messages.some((message) => isForkOrigin(message) && message.forkOrigin?.sourceSessionId === input.sourceSessionId);
}
function isForkOrigin(message) {
    return message.kind === 'fork-origin' || message.displayKind === 'fork-origin';
}
//# sourceMappingURL=display-data-capability.js.map