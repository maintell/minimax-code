export function channelContextFromMessageContext(ctx) {
    return {
        platform: parseChannelPlatform(ctx.platform),
        chatType: ctx.chatType,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        clientName: ctx.clientName,
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
        ...(ctx.sourceMessageId ? { sourceMessageId: ctx.sourceMessageId } : {}),
        ...(ctx.contextToken ? { contextToken: ctx.contextToken } : {}),
        ...(ctx.targetAgentId ? { targetAgentId: ctx.targetAgentId } : {}),
    };
}
function parseChannelPlatform(platform) {
    if (platform === 'feishu' || platform === 'telegram' || platform === 'wechat')
        return platform;
    throw new Error(`Unsupported questionnaire channel platform: ${platform}`);
}
//# sourceMappingURL=channel-context.js.map