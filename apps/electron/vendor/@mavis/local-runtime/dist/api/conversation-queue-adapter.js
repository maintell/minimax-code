import { readLocalMessageInputs } from '../messages/input.js';
export function readConversationQueueMessage(body) {
    const message = readLocalMessageInputs(body)[0];
    if (!message || isEmptyMessage(message))
        return undefined;
    const model = readConversationModel(body);
    return {
        ...toConversationMessage(message),
        ...(model ? { model } : {}),
    };
}
export function readConversationQueueUpdate(body) {
    const hasMessage = hasOwn(body, 'content') || hasOwn(body, 'attachments');
    const message = hasMessage ? readLocalMessageInputs(body)[0] : undefined;
    if (message && isEmptyMessage(message))
        return 'invalid';
    const hasModel = hasOwn(body, 'model');
    const model = hasModel ? readConversationModel(body) : undefined;
    const expiresAt = readOptionalNumber(body, ['expiresAt', 'expires_at']);
    return {
        ...(message ? { message: toConversationMessage(message) } : {}),
        ...(hasModel ? { model: model ?? null } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
}
export function readConversationQueueAdmission(body) {
    const clientRequestId = readOptionalString(body, ['clientRequestId', 'client_request_id']);
    const expiresAt = readOptionalNumber(body, ['expiresAt', 'expires_at']);
    return {
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
}
export function serializeConversationQueuedItem(item) {
    return {
        itemId: item.itemId,
        item_id: item.itemId,
        sessionId: item.sessionId,
        session_id: item.sessionId,
        agentName: item.agentName,
        agent_name: item.agentName,
        source: item.source,
        status: item.status,
        content: item.message.displayContent ?? item.message.content,
        attachments: (item.message.attachments ?? []).map(serializeAttachment),
        ...(item.message.model ? { model: serializeModel(item.message.model) } : {}),
        createdAt: item.createdAt,
        created_at: item.createdAt,
        ...(item.clientRequestId
            ? {
                clientRequestId: item.clientRequestId,
                client_request_id: item.clientRequestId,
            }
            : {}),
        ...(item.expiresAt !== undefined
            ? { expiresAt: item.expiresAt, expires_at: item.expiresAt }
            : {}),
    };
}
function toConversationMessage(message) {
    return {
        content: message.content,
        attachments: message.attachments.map((attachment) => ({ ...attachment })),
        ...(message.origin !== undefined ? { origin: message.origin } : {}),
        ...(message.quotedMessage ? { quotedMessage: { ...message.quotedMessage } } : {}),
        ...(message.channelContext
            ? {
                channelContext: {
                    platform: message.channelContext.platform,
                    chatType: message.channelContext.chatType,
                    chatId: message.channelContext.chatId,
                    senderId: message.channelContext.senderId,
                    clientName: message.channelContext.clientName,
                    ...(message.channelContext.threadId
                        ? { threadId: message.channelContext.threadId }
                        : {}),
                    ...(message.channelContext.sourceMessageId
                        ? { sourceMessageId: message.channelContext.sourceMessageId }
                        : {}),
                    ...(message.channelContext.contextToken
                        ? { contextToken: message.channelContext.contextToken }
                        : {}),
                    ...(message.channelContext.targetAgentId
                        ? { targetAgentId: message.channelContext.targetAgentId }
                        : {}),
                },
            }
            : {}),
    };
}
function readConversationModel(body) {
    const raw = body.model;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const model = raw;
    const providerId = readOptionalString(model, ['providerId', 'provider_id']);
    const modelId = readOptionalString(model, ['modelId', 'model_id']);
    const variant = readOptionalString(model, ['variant']);
    if (!providerId && !modelId && !variant)
        return undefined;
    return {
        ...(providerId ? { providerId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(variant ? { variant } : {}),
    };
}
function serializeModel(model) {
    return {
        ...(model.providerId ? { provider_id: model.providerId } : {}),
        ...(model.modelId ? { model_id: model.modelId } : {}),
        ...(model.variant ? { variant: model.variant } : {}),
    };
}
function serializeAttachment(attachment) {
    return {
        type: attachment.type,
        filePath: attachment.filePath,
        file_path: attachment.filePath,
        fileName: attachment.fileName,
        file_name: attachment.fileName,
        mimeType: attachment.mimeType,
        mime_type: attachment.mimeType,
        ...(attachment.assetId ? { assetId: attachment.assetId, asset_id: attachment.assetId } : {}),
        ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl, data_url: attachment.dataUrl } : {}),
        ...(attachment.error ? { error: attachment.error } : {}),
    };
}
function isEmptyMessage(message) {
    return message.content.length === 0 && message.attachments.length === 0;
}
function hasOwn(body, key) {
    return Object.prototype.hasOwnProperty.call(body, key);
}
function readOptionalString(body, keys) {
    return keys
        .map((key) => body[key])
        .find((value) => typeof value === 'string' && value.length > 0);
}
function readOptionalNumber(body, keys) {
    return keys
        .map((key) => body[key])
        .map((value) => typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN)
        .find(Number.isFinite);
}
//# sourceMappingURL=conversation-queue-adapter.js.map