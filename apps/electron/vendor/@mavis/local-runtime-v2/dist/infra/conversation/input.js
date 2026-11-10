import { basename } from 'node:path';
export { loadUserMediaCandidatesForMessages } from './user-media.js';
export function readLocalMessageInputs(data) {
    const primary = {
        content: readString(data, 'content') ?? '',
        attachments: readAttachments(data),
        ...(readFirstString(data, ['queueItemId', 'queue_item_id'])
            ? { queueItemId: readFirstString(data, ['queueItemId', 'queue_item_id']) }
            : {}),
        ...readOptionalProtocolMetadata(data),
        ...readOptionalQuotedMessage(data),
        ...readOptionalChannelContext(data),
    };
    const queuedMessages = readQueuedLocalMessages(data);
    if (primary.content.length > 0 || primary.attachments.length > 0 || queuedMessages.length === 0) {
        return [primary, ...queuedMessages];
    }
    return queuedMessages;
}
function readQueuedLocalMessages(data) {
    const raw = data.queuedMessages;
    if (!Array.isArray(raw))
        return [];
    const messages = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const obj = item;
        const message = {
            content: readString(obj, 'content') ?? '',
            attachments: readAttachments(obj),
            ...(readFirstString(obj, ['queueItemId', 'queue_item_id'])
                ? { queueItemId: readFirstString(obj, ['queueItemId', 'queue_item_id']) }
                : {}),
            ...readOptionalProtocolMetadata(obj),
        };
        if (message.content.length === 0 && message.attachments.length === 0)
            continue;
        messages.push(message);
    }
    return messages;
}
function readAttachments(data) {
    const raw = data.attachments;
    if (!Array.isArray(raw))
        return [];
    const attachments = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const attachment = readAttachment(item);
        if (attachment)
            attachments.push(attachment);
    }
    return attachments;
}
function readAttachment(obj) {
    const filePath = readFirstString(obj, ['filePath', 'file_path']);
    const desktopPath = readFirstString(obj, ['desktopPath', 'desktop_path']);
    const dataUrl = readFirstString(obj, ['dataUrl', 'data_url', 'previewUrl', 'preview_url']);
    const assetId = readFirstString(obj, ['assetId', 'asset_id']);
    const mimeType = readFirstString(obj, ['mimeType', 'mime_type']) ?? '';
    const resolvedFilePath = filePath ?? desktopPath;
    if (!resolvedFilePath && !dataUrl)
        return undefined;
    return {
        ...readAttachmentIdentity(obj, mimeType, resolvedFilePath),
        filePath: resolvedFilePath ?? '',
        mimeType,
        ...(desktopPath ? { desktopPath } : {}),
        ...(dataUrl ? { dataUrl } : {}),
        ...(assetId ? { assetId } : {}),
    };
}
function readAttachmentIdentity(obj, mimeType, filePath) {
    return {
        type: obj.type === 'image' || mimeType.startsWith('image/') ? 'image' : 'file',
        fileName: readFirstString(obj, ['fileName', 'file_name']) ??
            (filePath ? basename(filePath) : 'attachment'),
    };
}
function readString(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readFirstString(data, keys) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
function readFirstPresent(data, keys) {
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(data, key))
            return data[key];
    }
    return undefined;
}
/**
 * Read optional `quotedMessage` from an inbound body. Returns a spread-able
 * object so the caller can merge it into LocalMessageInput with `...`.
 */
function readOptionalQuotedMessage(data) {
    const raw = data.quotedMessage ?? data.quoted_message;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const obj = raw;
    const text = readFirstString(obj, ['text', 'content']);
    if (!text)
        return {};
    return {
        quotedMessage: {
            text,
            ...(readFirstString(obj, ['senderName', 'sender_name'])
                ? { senderName: readFirstString(obj, ['senderName', 'sender_name']) }
                : {}),
        },
    };
}
function readOptionalProtocolMetadata(data) {
    const source = readFirstString(data, ['source']);
    const origin = readFirstPresent(data, ['origin', 'originJson', 'origin_json']);
    return {
        ...(source ? { source } : {}),
        ...(origin !== undefined ? { origin } : {}),
    };
}
/**
 * Read optional `channelContext` from an inbound body.
 */
function readOptionalChannelContext(data) {
    const raw = data.channelContext ?? data.channel_context;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const obj = raw;
    const platform = readFirstString(obj, ['platform']);
    const chatType = readFirstString(obj, ['chatType', 'chat_type']);
    const chatId = readFirstString(obj, ['chatId', 'chat_id']);
    const senderId = readFirstString(obj, ['senderId', 'sender_id']);
    const clientName = readFirstString(obj, ['clientName', 'client_name']);
    if (!platform || !chatId || !senderId)
        return {};
    return {
        channelContext: {
            platform,
            chatType: chatType ?? 'private',
            chatId,
            senderId,
            clientName: clientName ?? '',
            ...readChannelRoutingContext(obj),
        },
    };
}
function readChannelRoutingContext(obj) {
    const threadId = readFirstString(obj, ['threadId', 'thread_id']);
    const sourceMessageId = readFirstString(obj, ['sourceMessageId', 'source_message_id']);
    const contextToken = readFirstString(obj, ['contextToken', 'context_token']);
    const targetAgentId = readFirstString(obj, ['targetAgentId', 'target_agent_id']);
    return {
        ...(threadId ? { threadId } : {}),
        ...(sourceMessageId ? { sourceMessageId } : {}),
        ...(contextToken ? { contextToken } : {}),
        ...(targetAgentId ? { targetAgentId } : {}),
    };
}
//# sourceMappingURL=input.js.map