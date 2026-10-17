import { readFirstString } from '../../../record-read.js';
import { wechatClientId } from '../wechat-store.js';
import { extractWeChatAttachmentRefs } from './wechat-attachment-support.js';
export function parseLocalWeChatEvent(body, defaultAgentName = 'mavis') {
    const normalized = normalizeWeChatMessageEvent(body);
    if (!normalized) {
        return {
            error: {
                status: 400,
                code: 'VALIDATION_ERROR',
                message: 'WeChat message event is required',
            },
        };
    }
    const { chatId, senderId } = normalized;
    if (!chatId || !senderId) {
        return {
            error: {
                status: 400,
                code: 'VALIDATION_ERROR',
                message: 'WeChat chat id and sender id are required',
            },
        };
    }
    const botName = readFirstString(body, ['botName', 'bot_name', 'name']);
    return {
        ctx: buildWeChatInboundCtx(body, { ...normalized, chatId, senderId }, botName, defaultAgentName),
        text: stripWeChatBotMention(normalized.text, botName),
        attachmentRefs: extractWeChatAttachmentRefs(body),
        ...(normalized.eventId ? { eventId: normalized.eventId } : {}),
    };
}
/** Transport ctx assembly for one parsed WeChat message event. */
function buildWeChatInboundCtx(body, normalized, botName, defaultAgentName) {
    const agentName = readFirstString(body, ['agentName', 'agentId', 'agent', 'agent_name']) ?? defaultAgentName;
    const clientName = readFirstString(body, ['clientName', 'clientId', 'client_id']) ?? wechatClientId(agentName);
    return {
        platform: 'wechat',
        chatType: normalized.chatType,
        chatId: normalized.chatId,
        senderId: normalized.senderId,
        clientName,
        ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
        ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
        // p2p chats are implicitly addressed to the bot; groups need a mention.
        hasMention: body.hasMention === true ||
            body.mentioned === true ||
            normalized.chatType === 'p2p' ||
            wechatTextMentionsBot(normalized.text, botName),
    };
}
function normalizeWeChatMessageEvent(body) {
    const payload = isRecord(body.payload) ? body.payload : body;
    const event = isRecord(payload.event) ? payload.event : payload;
    const message = firstRecord(event, ['message', 'msg']) ?? event;
    if (!isRecord(message))
        return undefined;
    const identity = readWeChatMessageIdentity(message, event);
    const text = extractWeChatText(message);
    if (!text && !identity.chatId && !identity.senderId)
        return undefined;
    return {
        eventId: stringish(message.message_id) ?? stringish(message.client_id) ?? stringish(payload.event_id),
        ...identity,
        threadId: readFirstString(message, ['session_id', 'sessionId']),
        text,
    };
}
/** chat/sender identity; a bare group id implies chatType 'group'. */
function readWeChatMessageIdentity(message, event) {
    const senderId = readFirstString(message, ['from_user_id', 'fromUserId', 'senderId', 'sender_id', 'open_id']) ??
        readFirstString(event, ['from_user_id', 'fromUserId', 'senderId', 'sender_id', 'open_id']);
    const groupId = readFirstString(message, ['group_id', 'groupId']);
    const chatType = normalizeWeChatChatType(readFirstString(message, ['chat_type', 'chatType']) ?? (groupId ? 'group' : 'p2p'));
    const chatId = readFirstString(message, ['chat_id', 'chatId']) ?? (chatType === 'group' ? groupId : senderId);
    return { chatType, chatId, senderId };
}
function extractWeChatText(message) {
    const direct = readFirstString(message, ['text', 'content', 'message']);
    if (direct)
        return direct;
    const content = message.content;
    if (typeof content === 'string') {
        const parsed = safeJson(content);
        if (isRecord(parsed))
            return extractWeChatText(parsed);
        return content;
    }
    const items = readItemList(message);
    return items
        .map((item) => {
        if (!isRecord(item))
            return undefined;
        const type = item.type;
        if (type === 1 || type === 'text') {
            const textItem = isRecord(item.text_item) ? item.text_item : item;
            return readFirstString(textItem, ['text', 'content']);
        }
        if (type === 3 || type === 'voice') {
            const voiceItem = isRecord(item.voice_item) ? item.voice_item : item;
            return readFirstString(voiceItem, ['text']);
        }
        return undefined;
    })
        .filter((value) => Boolean(value))
        .join('\n');
}
function wechatTextMentionsBot(text, botName) {
    if (!botName)
        return false;
    const normalized = botName.replace(/^@/u, '').toLowerCase();
    return text.toLowerCase().includes(`@${normalized}`);
}
/**
 * Strip a leading/inline `@<bot>` mention from a WeChat inbound text so slash
 * commands parse in group chats. When a member @-mentions the bot, WeChat
 * inserts `@<nickname>` followed by whitespace (a regular space or the
 * four-per-em space U+2005), so a command arrives as `@bot<space>/new` — which
 * does not start with `/` and would be treated as a normal message. Mirrors
 * Feishu's mention normalisation + Telegram's `stripTelegramBotMention` so all
 * three IM platforms handle group commands consistently. No-op when the bot
 * name is unknown or unmentioned.
 */
function stripWeChatBotMention(text, botName) {
    if (!botName)
        return text;
    const handle = botName.replace(/^@/u, '');
    if (!handle)
        return text;
    const stripped = text
        .replace(new RegExp(`@${escapeWeChatRegExp(handle)}[\\s\\u2005]*`, 'giu'), '')
        .trim();
    return stripped || text;
}
function escapeWeChatRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function normalizeWeChatChatType(value) {
    if (value === 'group' || value === 'p2p')
        return value;
    if (value === 'private')
        return 'p2p';
    return typeof value === 'string' && value.trim() ? value.trim() : 'p2p';
}
function firstRecord(raw, keys) {
    for (const key of keys) {
        if (isRecord(raw[key]))
            return raw[key];
    }
    return undefined;
}
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function safeJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function stringish(value) {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
/** iLink puts attachments under `item_list` (snake) or `items` (camel). */
function readItemList(message) {
    if (Array.isArray(message['item_list']))
        return message['item_list'];
    if (Array.isArray(message['items']))
        return message['items'];
    return [];
}
//# sourceMappingURL=wechat-events.js.map