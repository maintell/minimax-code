export function resolveChannelRoute(input) {
    const source = input?.source;
    if (!source || (!source.startsWith('channel:') && source !== 'questionnaire')) {
        return undefined;
    }
    const sourceContext = nestedChannelContext(input.sourceContext);
    if (!sourceContext)
        return undefined;
    const platform = readString(sourceContext, 'platform');
    const chatType = readString(sourceContext, 'chatType');
    const chatId = readString(sourceContext, 'chatId');
    const senderId = readString(sourceContext, 'senderId');
    const clientName = readString(sourceContext, 'clientName');
    if (!platform || !chatType || !chatId || !senderId || !clientName)
        return undefined;
    return {
        platform,
        chatType,
        chatId,
        senderId,
        clientName,
        ...optionalString(sourceContext, 'threadId'),
        ...optionalString(sourceContext, 'sourceMessageId'),
        ...optionalString(sourceContext, 'contextToken'),
        ...optionalString(sourceContext, 'channel'),
        ...optionalString(sourceContext, 'channel_id'),
    };
}
function nestedChannelContext(sourceContext) {
    if (!sourceContext)
        return undefined;
    const nested = sourceContext.channelContext;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested
        : sourceContext;
}
function optionalString(value, key) {
    const field = readString(value, key);
    return field ? { [key]: field } : {};
}
function readString(value, key) {
    const field = value[key];
    return typeof field === 'string' && field.trim() ? field : undefined;
}
//# sourceMappingURL=routing.js.map