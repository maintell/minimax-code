import { feishuClientId, readFeishuAgentName } from './feishu-store.js';
import { extractFeishuAttachmentRefs } from './outbound/feishu-attachments.js';
import { readFirstString } from '../../record-read.js';
export function parseLocalFeishuEvent(body, defaultAgentName = 'mavis', botIdentity) {
    const normalized = normalizeFeishuMessageEvent(body);
    if (!normalized) {
        return {
            error: {
                status: 400,
                code: 'VALIDATION_ERROR',
                message: 'Feishu message event is required',
            },
        };
    }
    const chatId = normalized.chatId;
    const senderId = normalized.senderId ?? chatId;
    if (!chatId || !senderId) {
        return {
            error: {
                status: 400,
                code: 'VALIDATION_ERROR',
                message: 'Feishu chat_id and sender id are required',
            },
        };
    }
    const { resolvedBotIdentity, clientName } = resolveFeishuEventIdentity(body, defaultAgentName, botIdentity);
    const text = normalizeFeishuMentionText(extractFeishuText(normalized.content), normalized.mentions, resolvedBotIdentity, normalized.senderName);
    const mentionAll = feishuMentionsAll(normalized.mentions) || textContainsFeishuMentionAll(normalized.content);
    // P1-B: extract attachment refs (image / file / audio / video) from
    // the message so the inbound handler can resolve them to local files
    // before dispatch. The actual download is best-effort and decoupled
    // from parseLocalFeishuEvent so unit tests don't need a network.
    const attachmentRefs = extractFeishuAttachmentRefs(body, normalized.messageType, normalized.content);
    const quotedThreadId = readQuotedThreadId(normalized);
    return {
        ctx: buildFeishuInboundCtx({
            body,
            normalized,
            chatId,
            senderId,
            clientName,
            resolvedBotIdentity,
            mentionAll,
        }),
        text,
        attachmentRefs,
        ...(normalized.eventId ? { eventId: normalized.eventId } : {}),
        ...(normalized.messageId ? { messageId: normalized.messageId } : {}),
        ...(quotedThreadId ? { quotedThreadId } : {}),
    };
}
/**
 * A thread/topic (`thread_id`/`root_id`) is what we fetch as quoted context:
 * the thread id resolves to the topic's root message. A bare `parent_id`
 * (quoted reply outside a thread) is intentionally NOT treated as a thread —
 * see `normalizeFeishuMessageEvent`.
 */
function readQuotedThreadId(normalized) {
    return normalized.threadId && normalized.threadId !== normalized.messageId
        ? normalized.threadId
        : undefined;
}
/** Bot identity + client name resolution for one inbound event body. */
function resolveFeishuEventIdentity(body, defaultAgentName, botIdentity) {
    const agentName = readFeishuAgentName(body, defaultAgentName);
    const botName = readFirstString(body, ['botName', 'bot_name', 'name']) ?? botIdentity?.name;
    const resolvedBotIdentity = botName ? { ...botIdentity, name: botName } : botIdentity;
    const clientName = readFirstString(body, ['clientName', 'clientId', 'client_id']) ?? feishuClientId(agentName);
    return { resolvedBotIdentity, clientName };
}
/** Transport ctx assembly for one parsed Feishu message event. */
function buildFeishuInboundCtx(input) {
    const { body, normalized, chatId, senderId, clientName, resolvedBotIdentity } = input;
    const chatType = normalizeFeishuChatType(normalized.chatType);
    return {
        platform: 'feishu',
        chatType,
        chatId,
        senderId,
        clientName,
        ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
        ...(normalized.messageId ? { sourceMessageId: normalized.messageId } : {}),
        ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
        // p2p chats are implicitly addressed to the bot; groups need a mention.
        hasMention: body.hasMention === true ||
            body.mentioned === true ||
            chatType === 'p2p' ||
            feishuMentionsBot(normalized.mentions, resolvedBotIdentity),
        ...(input.mentionAll ? { mentionAll: true } : {}),
    };
}
function normalizeFeishuMessageEvent(body) {
    const payload = isRecord(body.payload) ? body.payload : body;
    const event = isRecord(payload.event) ? payload.event : payload;
    const message = isRecord(event.message) ? event.message : event;
    if (!isRecord(message) && !readFirstString(event, ['chat_id', 'chatId']))
        return undefined;
    const sender = isRecord(event.sender) ? event.sender : {};
    return {
        eventId: stringish(payload.event_id) ?? stringish(body.event_id) ?? stringish(message.message_id),
        chatId: readFirstString(message, ['chat_id', 'chatId']),
        chatType: readFirstString(message, ['chat_type', 'chatType']),
        senderId: readFeishuSenderId(event, sender),
        senderName: readFeishuSenderName(event, message, sender),
        content: message.content,
        mentions: message.mentions,
        // `thread_id` (and the legacy `root_id`) mark a message that lives inside a
        // Feishu thread/topic. `parent_id` alone (a quoted reply outside a thread)
        // must NOT be treated as a thread — otherwise every quote reply would spawn
        // an isolated session and get answered in-thread by mistake.
        threadId: readFirstString(message, ['thread_id', 'threadId', 'root_id', 'rootId']),
        parentId: readFirstString(message, ['parent_id', 'parentId']),
        messageType: readFirstString(message, ['message_type', 'messageType']),
        messageId: readFirstString(message, ['message_id', 'messageId']),
    };
}
/** sender_id lives either flat on the event or nested in sender.sender_id. */
function readFeishuSenderId(event, sender) {
    const senderIdRecord = isRecord(sender.sender_id) ? sender.sender_id : {};
    return (readFirstString(event, ['sender_id', 'senderId']) ??
        readFirstString(senderIdRecord, ['open_id', 'user_id', 'union_id']));
}
export function feishuMessageSnapshotToQuotedMessage(snapshot) {
    if (!snapshot)
        return undefined;
    const text = describeFeishuQuotedContent(snapshot);
    if (!text)
        return undefined;
    const quoted = { text };
    const senderName = snapshot.senderName?.trim() || feishuSenderFallback(snapshot.senderId);
    if (senderName)
        quoted.senderName = senderName;
    return quoted;
}
function describeFeishuQuotedContent(snapshot) {
    const text = extractFeishuText(snapshot.content).trim();
    if (text)
        return text;
    switch (snapshot.messageType) {
        case 'image':
            return '[图片]';
        case 'audio':
            return '[语音]';
        case 'media':
        case 'video':
            return '[视频]';
        case 'file':
            return '[文件]';
        default:
            return '';
    }
}
function feishuSenderFallback(senderId) {
    if (!senderId)
        return undefined;
    const suffix = senderId.slice(-6);
    return suffix ? `User ${suffix}` : undefined;
}
/**
 * Pull Feishu attachment refs out of a parsed event.
 *
 * Recognised sources (in priority order):
 *   1. Top-level `image_key` / `file_key` on the message content (image,
 *      file, audio, video single-resource messages). The resource type is
 *      derived from `messageType`; audio and video both use `file_key`
 *      but we tag them as `audio` / `video` so the downloader picks the
 *      right decoder hint.
 *   2. Inline `img` entries in `post` rich-text messages (each carries
 *      an `image_key` and lives inside a nested `zh_cn` / `en_us` /
 *      top-level `content` array).
 *
 * Other fields (file_name, file size, MIME hints) are forwarded when
 * present so the downloader can use them for hinting. The downloader
 * itself re-sniffs MIME from the buffer, so the hint is best-effort.
 */
export {} from './outbound/feishu-attachments.js';
function extractFeishuText(content) {
    if (typeof content === 'string') {
        const parsed = safeJson(content);
        if (isRecord(parsed))
            return extractFeishuText(parsed);
        return content;
    }
    if (!isRecord(content))
        return '';
    const text = readFirstString(content, ['text', 'title', 'content']);
    if (text)
        return text;
    const richText = extractNestedFeishuText(content.content);
    if (richText)
        return richText;
    const elements = Array.isArray(content.elements) ? content.elements : [];
    return elements
        .map((element) => isRecord(element) ? readFirstString(element, ['text', 'content']) : undefined)
        .filter((value) => Boolean(value))
        .join('\n');
}
function extractNestedFeishuText(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value)) {
        return value.map(extractNestedFeishuText).filter(Boolean).join('\n');
    }
    if (!isRecord(value))
        return '';
    const direct = readFirstString(value, ['text', 'title']);
    if (direct)
        return direct;
    if ('content' in value) {
        const nested = extractNestedFeishuText(value.content);
        if (nested)
            return nested;
    }
    if ('elements' in value) {
        const nested = extractNestedFeishuText(value.elements);
        if (nested)
            return nested;
    }
    if (readFirstString(value, ['tag']) === 'img')
        return '[图片]';
    return '';
}
function normalizeFeishuMentionText(text, mentions, botIdentity, senderName) {
    if (!text)
        return text;
    const replaced = replaceMentionKeys(text, mentions, botIdentity);
    // Some WS payloads carry the raw @_all placeholder but omit `mentions`.
    const next = replaced.text.split('@_all').join('');
    const normalized = next.replace(/[ \t]{2,}/gu, ' ').trim();
    if (!replaced.botMentioned || !senderName)
        return normalized;
    const displayName = senderName.replace(/^@/u, '');
    return normalized ? `${normalized} from User ${displayName}` : `from User ${displayName}`;
}
/** Replace @-mention placeholder keys; @all is stripped, bot mentions tracked. */
function replaceMentionKeys(text, mentions, botIdentity) {
    let next = text;
    let botMentioned = false;
    if (!Array.isArray(mentions))
        return { text: next, botMentioned };
    for (const mention of mentions) {
        if (!isRecord(mention))
            continue;
        const key = readFirstString(mention, ['key', 'mention_key', 'mentionKey']);
        if (!key)
            continue;
        if (isFeishuMentionAllKey(key)) {
            next = next.split(key).join('');
            continue;
        }
        const botMention = isBotMention(mention, botIdentity);
        if (botMention)
            botMentioned = true;
        const replacementName = botMention ? undefined : readFirstString(mention, ['name']);
        const replacement = replacementName ? `@${replacementName.replace(/^@/u, '')}` : '';
        next = next.split(key).join(replacement);
    }
    return { text: next, botMentioned };
}
function readFeishuSenderName(event, message, sender) {
    return (readFirstString(event, ['senderName', 'sender_name', 'name', 'nickname']) ??
        readFirstString(message, ['senderName', 'sender_name']) ??
        readFirstString(sender, ['senderName', 'sender_name', 'name', 'nickname']));
}
function feishuMentionsBot(mentions, botIdentity) {
    if (!Array.isArray(mentions))
        return false;
    return mentions.some((mention) => isRecord(mention) && isBotMention(mention, botIdentity));
}
function feishuMentionsAll(mentions) {
    if (!Array.isArray(mentions))
        return false;
    return mentions.some((mention) => isRecord(mention) &&
        isFeishuMentionAllKey(readFirstString(mention, ['key', 'mention_key', 'mentionKey']) ?? ''));
}
function textContainsFeishuMentionAll(content) {
    return extractFeishuText(content).includes('@_all');
}
function isFeishuMentionAllKey(key) {
    return key.trim() === '@_all';
}
function isBotMention(mention, botIdentity) {
    const mentionId = readFirstString(isRecord(mention.id) ? mention.id : {}, [
        'open_id',
        'user_id',
        'union_id',
    ]);
    if (botIdentity?.openId && mentionId)
        return mentionId === botIdentity.openId;
    if (!botIdentity?.name)
        return false;
    const name = readFirstString(mention, ['name']);
    return name?.toLowerCase() === botIdentity.name.replace(/^@/u, '').toLowerCase();
}
/** Exported for the MR3 HTTP edge (webhook URL verification handshake). */
export function isFeishuUrlVerification(body) {
    return ((body.type === 'url_verification' || body.type === 'url_verification_callback') &&
        typeof body.challenge === 'string');
}
/** Exported for the MR3 HTTP edge (webhook URL verification handshake). */
export function readFeishuVerificationToken(body) {
    const header = isRecord(body.header) ? body.header : undefined;
    return (readFirstString(body, ['token', 'verificationToken', 'verification_token']) ??
        (header
            ? readFirstString(header, ['token', 'verificationToken', 'verification_token'])
            : undefined));
}
function normalizeFeishuChatType(value) {
    if (value === 'group' || value === 'p2p')
        return value;
    if (value === 'private')
        return 'p2p';
    return typeof value === 'string' && value.trim() ? value.trim() : 'p2p';
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
//# sourceMappingURL=feishu-events.js.map