import { isUserMessageId } from '../shared/user-message-id.js';
/** Display-only relation rows never participate in the conversational Fork boundary. */
export function resolveForkDisplayBoundary(messages, assistantMessageId) {
    const assistantIndex = assistantMessageId === undefined
        ? findLatestAssistantIndex(messages)
        : messages.findIndex((message) => message.msg_id === assistantMessageId);
    const assistant = assistantIndex >= 0 ? messages[assistantIndex] : undefined;
    const nextUser = assistantIndex >= 0
        ? messages
            .slice(assistantIndex + 1)
            .find((message) => message.role === 'user' && isUserMessageId(message.msg_id))
        : undefined;
    const latestConversationMessage = messages.slice().reverse().find(isConversationMessage);
    return {
        assistant,
        assistantIndex,
        assistantCanonicalMessageId: canonicalMessageId(assistant),
        beforeUserMessageId: nextUser?.msg_id && isUserMessageId(nextUser.msg_id) ? nextUser.msg_id : undefined,
        isLatestConversationMessage: assistant !== undefined && latestConversationMessage?.msg_id === assistant.msg_id,
    };
}
function canonicalMessageId(message) {
    const value = message?.canonical_message_id;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function findLatestAssistantIndex(messages) {
    const reverseIndex = messages
        .slice()
        .reverse()
        .findIndex((message) => message.role === 'assistant' && !isSpecial(message));
    return reverseIndex < 0 ? -1 : messages.length - reverseIndex - 1;
}
function isConversationMessage(message) {
    if (isSpecial(message))
        return false;
    return (message.role === 'assistant' || (message.role === 'user' && isUserMessageId(message.msg_id)));
}
function isSpecial(message) {
    return ((typeof message.kind === 'string' && message.kind.length > 0) ||
        (typeof message.displayKind === 'string' && message.displayKind.length > 0));
}
//# sourceMappingURL=display-boundary.js.map