export function toAgentMessages(messages) {
    return messages.flatMap((message) => {
        if (isAgentMessage(message.raw))
            return [message.raw];
        const msgId = message.msgId;
        if (!msgId)
            return [];
        return [
            {
                msg_id: msgId,
                ...(message.role === 'user' || message.role === 'assistant' ? { role: message.role } : {}),
                ...(message.text ? { msg_content: message.text } : {}),
                ...(message.thinking ? { thinking_content: message.thinking } : {}),
                ...(message.toolCalls ? { tool_calls: [...message.toolCalls] } : {}),
                ...compactionKind(message),
            },
        ];
    });
}
function compactionKind(message) {
    if (message.kind === 'compaction_start' ||
        message.kind === 'compaction' ||
        message.kind === 'compaction_failed') {
        return { kind: message.kind };
    }
    return {};
}
function isAgentMessage(value) {
    return (typeof value === 'object' && value !== null && typeof Reflect.get(value, 'msg_id') === 'string');
}
//# sourceMappingURL=conversation-message-adapter.js.map