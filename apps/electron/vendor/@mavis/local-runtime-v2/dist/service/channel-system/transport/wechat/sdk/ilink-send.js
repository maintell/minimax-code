/**
 * Migration copy (MR1) of v1 `channels/adapters/wechat/sdk/ilink-send.ts`.
 */
/**
 * iLink Bot SDK — High-level message send helpers.
 *
 * Wraps ILinkClient.sendMessage() with proper message construction for
 * text, image, video, and file messages. Handles CDN media metadata,
 * aes_key encoding, and enforces protocol invariants (from_user_id="",
 * context_token required).
 */
import crypto from 'node:crypto';
import { MessageType, MessageState, MessageItemType, } from './ilink-types.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateClientId() {
    return `sdk-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
/**
 * Build a SendMessageReq with a single item.
 * Enforces protocol invariants: from_user_id="", message_type=BOT, message_state=FINISH.
 */
function buildSendReq(params) {
    return {
        msg: {
            from_user_id: '',
            to_user_id: params.to,
            client_id: generateClientId(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: params.items.length > 0 ? params.items : undefined,
            context_token: params.contextToken,
        },
    };
}
/**
 * Encode aes_key for CDNMedia: hex-encoded raw key → base64.
 * Reference: send.ts line 194 — `Buffer.from(uploaded.aeskey).toString("base64")`
 * where uploaded.aeskey is hex-encoded (32 chars representing 16 bytes).
 */
function aesKeyHexToBase64(hexKey) {
    return Buffer.from(hexKey).toString('base64');
}
// ---------------------------------------------------------------------------
// Send functions
// ---------------------------------------------------------------------------
/**
 * Send a plain text message.
 * @throws If contextToken is missing.
 */
export async function sendTextMessage(client, params) {
    if (!params.contextToken) {
        throw new Error('sendTextMessage: contextToken is required');
    }
    const items = params.text
        ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
        : [];
    const req = buildSendReq({
        to: params.to,
        contextToken: params.contextToken,
        items,
    });
    await client.sendMessage(req);
    return { messageId: req.msg.client_id };
}
/**
 * Send an image message with CDN-uploaded media metadata.
 *
 * ImageItem fields:
 *   - media.encrypt_query_param: CDN download param
 *   - media.aes_key: hex key → base64 encoded
 *   - media.encrypt_type: 1
 *   - mid_size: ciphertext file size
 *
 * @throws If contextToken is missing.
 */
export async function sendImageMessage(client, params) {
    if (!params.contextToken) {
        throw new Error('sendImageMessage: contextToken is required');
    }
    const { uploaded } = params;
    const items = [];
    if (params.text) {
        items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
    }
    items.push({
        type: MessageItemType.IMAGE,
        image_item: {
            media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: aesKeyHexToBase64(uploaded.aeskey),
                encrypt_type: 1,
            },
            mid_size: uploaded.fileSizeCiphertext,
        },
    });
    // Send each item separately (text caption + image as individual requests)
    let lastMessageId = '';
    for (const item of items) {
        const req = buildSendReq({
            to: params.to,
            contextToken: params.contextToken,
            items: [item],
        });
        await client.sendMessage(req);
        lastMessageId = req.msg.client_id;
    }
    return { messageId: lastMessageId };
}
/**
 * Send a video message with CDN-uploaded media metadata.
 *
 * VideoItem fields:
 *   - media.encrypt_query_param, aes_key (hex→base64), encrypt_type: 1
 *   - video_size: ciphertext file size
 *
 * @throws If contextToken is missing.
 */
export async function sendVideoMessage(client, params) {
    if (!params.contextToken) {
        throw new Error('sendVideoMessage: contextToken is required');
    }
    const { uploaded } = params;
    const items = [];
    if (params.text) {
        items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
    }
    items.push({
        type: MessageItemType.VIDEO,
        video_item: {
            media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: aesKeyHexToBase64(uploaded.aeskey),
                encrypt_type: 1,
            },
            video_size: uploaded.fileSizeCiphertext,
        },
    });
    let lastMessageId = '';
    for (const item of items) {
        const req = buildSendReq({
            to: params.to,
            contextToken: params.contextToken,
            items: [item],
        });
        await client.sendMessage(req);
        lastMessageId = req.msg.client_id;
    }
    return { messageId: lastMessageId };
}
/**
 * Send a file attachment with CDN-uploaded media metadata.
 *
 * FileItem fields:
 *   - media.encrypt_query_param, aes_key (hex→base64), encrypt_type: 1
 *   - file_name: original file name
 *   - len: plaintext file size as string
 *
 * @throws If contextToken is missing.
 */
export async function sendFileMessage(client, params) {
    if (!params.contextToken) {
        throw new Error('sendFileMessage: contextToken is required');
    }
    const { uploaded, fileName } = params;
    const items = [];
    if (params.text) {
        items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
    }
    items.push({
        type: MessageItemType.FILE,
        file_item: {
            media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: aesKeyHexToBase64(uploaded.aeskey),
                encrypt_type: 1,
            },
            file_name: fileName,
            len: String(uploaded.fileSize),
        },
    });
    let lastMessageId = '';
    for (const item of items) {
        const req = buildSendReq({
            to: params.to,
            contextToken: params.contextToken,
            items: [item],
        });
        await client.sendMessage(req);
        lastMessageId = req.msg.client_id;
    }
    return { messageId: lastMessageId };
}
/**
 * Route a media file send by MIME type:
 *   - image/* → sendImageMessage
 *   - video/* → sendVideoMessage
 *   - else   → sendFileMessage
 *
 * @throws If contextToken is missing.
 */
export async function sendMediaFile(client, params) {
    const { mimeType, uploaded, fileName, ...sendParams } = params;
    if (mimeType.startsWith('image/')) {
        return sendImageMessage(client, { ...sendParams, uploaded });
    }
    if (mimeType.startsWith('video/')) {
        return sendVideoMessage(client, { ...sendParams, uploaded });
    }
    return sendFileMessage(client, { ...sendParams, uploaded, fileName });
}
//# sourceMappingURL=ilink-send.js.map