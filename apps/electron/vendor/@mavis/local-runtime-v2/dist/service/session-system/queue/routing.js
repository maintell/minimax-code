/** Stable dispatch identity; missing values and whitespace-only values normalize to null. */
export function queueRoutingFingerprint(item) {
    const context = routingContext(item);
    const fields = [
        ['source', normalizeRoutingValue(queueExecutionSource(item))],
        ['platform', readRoutingValue(context, ['platform'])],
        ['client', readRoutingValue(context, ['clientName', 'client_name', 'client'])],
        ['agent', normalizeRoutingValue(item.agentName)],
        ['agentBinding', readRoutingValue(context, ['agentName', 'agent_name', 'agentId', 'agent_id'])],
        ['binding', readRoutingValue(context, ['bindingId', 'binding_id'])],
        ['channel', readRoutingValue(context, ['channel'])],
        ['channelId', readRoutingValue(context, ['channel_id', 'channelId'])],
        ['thread', readRoutingValue(context, ['threadId', 'thread_id'])],
        ['chat', readRoutingValue(context, ['chatId', 'chat_id'])],
        ['scope', readRoutingValue(context, ['scope', 'scopeId', 'scope_id'])],
        ['chatType', readRoutingValue(context, ['chatType', 'chat_type'])],
        ['sender', readRoutingValue(context, ['senderId', 'sender_id'])],
    ];
    return `queue-routing/v1:${JSON.stringify(fields)}`;
}
export function queueRoutingProvenance(item) {
    const sourceContext = routingContext(item);
    return {
        source: queueExecutionSource(item),
        routingFingerprint: queueRoutingFingerprint(item),
        ...(sourceContext ? { sourceContext: { ...sourceContext } } : {}),
    };
}
function routingContext(item) {
    const channelContext = item.message.channelContext ?? item.channelContext;
    if (item.message.clientIntent === 'cloud-handoff') {
        return {
            ...(channelContext ?? {}),
            cloudHandoff: { trigger: 'slash' },
        };
    }
    if (queueExecutionSource(item) !== 'code_review')
        return channelContext;
    return {
        ...(channelContext ?? {}),
        review: {
            trigger: 'slash',
            scope: 'local_changes',
        },
    };
}
export function queueExecutionSource(item) {
    return item.message.source === 'code_review' ? 'code_review' : item.source;
}
function readRoutingValue(context, keys) {
    if (!context)
        return null;
    return keys.reduce((value, key) => value ?? normalizeRoutingValue(context[key]), null);
}
function normalizeRoutingValue(value) {
    if (typeof value !== 'string')
        return null;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}
//# sourceMappingURL=routing.js.map