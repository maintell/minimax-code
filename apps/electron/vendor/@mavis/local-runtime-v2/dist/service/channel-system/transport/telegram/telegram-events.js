import { pickLargestPhoto } from './telegram-attachment-downloader.js';
import { telegramClientId } from './telegram-store.js';
import { readFirstString } from '../../record-read.js';
export function parseLocalTelegramUpdate(body, defaultAgentName = 'mavis') {
    const rawUpdate = isRecord(body.update) ? body.update : body;
    const identity = readTelegramUpdateIdentity(rawUpdate);
    if ('error' in identity)
        return identity;
    const { message, chat, text, chatId, senderId } = identity;
    const botName = normalizeTelegramBotName(readFirstString(body, ['botName', 'username', 'botUsername']));
    const ctx = buildTelegramInboundCtx({
        body,
        message,
        chat,
        chatId,
        senderId,
        text,
        botName,
        defaultAgentName,
    });
    const eventId = stringish(rawUpdate.update_id);
    return {
        ctx,
        text: stripTelegramBotMention(text, botName).trim() || text,
        attachmentRefs: extractTelegramAttachmentRefs(message).map((item) => item.ref),
        ...(eventId ? { eventId } : {}),
    };
}
/** Message/chat/sender identity of one update; wire error when incomplete. */
function readTelegramUpdateIdentity(rawUpdate) {
    const message = firstRecord(rawUpdate, ['message', 'edited_message', 'channel_post']);
    if (!message) {
        return { error: telegramWireError('Telegram update message is required') };
    }
    const chat = isRecord(message.chat) ? message.chat : {};
    const from = isRecord(message.from) ? message.from : chat;
    const text = readFirstString(message, ['text', 'caption']) ?? '';
    const chatId = stringish(chat.id);
    const senderId = stringish(from.id) ?? chatId;
    if (!chatId || !senderId) {
        return { error: telegramWireError('Telegram chat.id and sender id are required') };
    }
    return { message, chat, text, chatId, senderId };
}
function telegramWireError(message) {
    return { status: 400, code: 'VALIDATION_ERROR', message };
}
/** Transport ctx assembly for one parsed Telegram update. */
function buildTelegramInboundCtx(input) {
    const { body, message, chat, chatId, senderId, text, botName } = input;
    const agentName = readFirstString(body, ['agentName', 'agentId', 'agent']) ?? input.defaultAgentName;
    const clientName = readFirstString(body, ['clientName', 'clientId', 'client_id']) ?? telegramClientId(agentName);
    const threadId = stringish(message.message_thread_id);
    return {
        platform: 'telegram',
        chatType: readFirstString(chat, ['type']) ?? 'private',
        chatId,
        senderId,
        clientName,
        ...(threadId ? { threadId } : {}),
        ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
        // Private chats are implicitly addressed to the bot; groups need a
        // textual or entity mention.
        hasMention: body.hasMention === true ||
            body.mentioned === true ||
            isPrivateChat(chat) ||
            telegramTextMentionsBot(text, botName) ||
            telegramEntitiesMentionBot(message.entities, text, botName),
    };
}
/**
 * Telegram's Bot API puts each media-bearing message variant on a dedicated
 * top-level key (`photo`, `document`, `voice`, `audio`, `video`, `sticker`).
 * This helper normalises all six into the platform-neutral
 * `ChannelInboundAttachmentRef` shape and pairs each ref with its kind so the
 * downloader can pick the right MIME fallback.
 *
 * Order matches Telegram's typical user behaviour: photos are usually the

 * first thing the user attaches, documents last. The order we return here
 * is the order the runner will see them, which is preserved through to the
 * agent prompt — keep it stable.
 *
 * Returns an empty array for text-only messages; never throws.
 */
export function extractTelegramAttachmentRefs(message) {
    const items = [];
    // `photo` is an array of size variants — pick the largest, unlike the
    // single-record kinds below.
    const photo = pickLargestPhoto(message.photo);
    if (photo && typeof photo.file_id === 'string') {
        items.push({
            kind: 'photo',
            ref: {
                type: 'image',
                key: photo.file_id,
                ...(typeof photo.file_unique_id === 'string' ? { name: photo.file_unique_id } : {}),
                ...sizeField(photo),
            },
        });
    }
    for (const rule of TELEGRAM_SINGLE_ATTACHMENT_RULES) {
        const item = singleAttachmentItem(message, rule);
        if (item)
            items.push(item);
    }
    return items;
}
/**
 * One rule per single-record Telegram media kind, in the exact v1 evaluation
 * order (sticker → video → voice → audio → document) so the ref order the
 * runner sees — and therefore the agent prompt order — stays stable.
 */
const TELEGRAM_SINGLE_ATTACHMENT_RULES = [
    {
        messageKey: 'sticker',
        kind: 'sticker',
        refType: 'image',
        nameKeys: ['emoji'],
        withMime: false,
    },
    { messageKey: 'video', kind: 'video', refType: 'video', nameKeys: ['file_name'], withMime: true },
    { messageKey: 'voice', kind: 'voice', refType: 'audio', nameKeys: [], withMime: true },
    {
        messageKey: 'audio',
        kind: 'audio',
        refType: 'audio',
        // file_name wins over title; both absent → no name field (v1 order).
        nameKeys: ['file_name', 'title'],
        withMime: true,
    },
    {
        messageKey: 'document',
        kind: 'document',
        refType: 'file',
        nameKeys: ['file_name'],
        withMime: true,
    },
];
function singleAttachmentItem(message, rule) {
    const raw = message[rule.messageKey];
    if (!isRecord(raw))
        return undefined;
    const record = raw;
    const fileId = readFirstString(record, ['file_id']);
    if (!fileId)
        return undefined;
    const name = readFirstString(record, rule.nameKeys);
    const mime = rule.withMime ? readFirstString(record, ['mime_type']) : undefined;
    return {
        kind: rule.kind,
        ref: {
            type: rule.refType,
            key: fileId,
            ...(name ? { name } : {}),
            ...(mime ? { mimeType: mime } : {}),
            ...sizeField(record),
        },
    };
}
function sizeField(record) {
    const size = readNumber(record.file_size);
    return size !== undefined ? { size } : {};
}
function firstRecord(raw, keys) {
    for (const key of keys) {
        if (isRecord(raw[key]))
            return raw[key];
    }
    return undefined;
}
/**
 * Locate the inbound Telegram message inside a webhook body. Mirrors the
 * `parseLocalTelegramUpdate` traversal so the downloader sees the same
 * payload structure that the parser used to populate `attachmentRefs`.
 * Returns an empty record when the body does not match the expected shape —
 * callers should treat that as "no attachments".
 */
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
function stringish(value) {
    if (typeof value === 'string' && value.trim())
        return value.trim();
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return undefined;
}
function readNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function isPrivateChat(chat) {
    return readFirstString(chat, ['type']) === 'private';
}
function telegramTextMentionsBot(text, botName) {
    if (!botName)
        return false;
    return text.toLowerCase().includes(`@${botName.replace(/^@/u, '').toLowerCase()}`);
}
function telegramEntitiesMentionBot(entities, text, botName) {
    if (!Array.isArray(entities))
        return false;
    return entities.some((entity) => {
        if (!isRecord(entity))
            return false;
        const type = readFirstString(entity, ['type']);
        const offset = readNumber(entity.offset);
        const length = readNumber(entity.length);
        if (offset === undefined || length === undefined) {
            return type === 'bot_command' && !botName;
        }
        const entityText = text.slice(offset, offset + length).toLowerCase();
        if (type === 'bot_command')
            return botCommandTargetsBot(entityText, botName);
        if (type !== 'mention')
            return false;
        const mention = entityText;
        return !botName || mention === `@${botName.replace(/^@/u, '').toLowerCase()}`;
    });
}
function botCommandTargetsBot(command, botName) {
    const atIndex = command.indexOf('@');
    if (atIndex < 0)
        return true;
    if (!botName)
        return false;
    return command.slice(atIndex + 1).toLowerCase() === botName.replace(/^@/u, '').toLowerCase();
}
function stripTelegramBotMention(text, botName) {
    if (!botName)
        return text;
    return text
        .replace(new RegExp(`@${escapeRegExp(botName.replace(/^@/u, ''))}\\b`, 'giu'), '')
        .trim();
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
/**
 * Reduce a stored Telegram bot name to the single `@username` token used for
 * mention/command matching. Older binds stored `${first_name} @${username}`
 * (two whitespace-separated tokens), which broke `stripTelegramBotMention`
 * and `botCommandTargetsBot` — they treat the whole string as one handle. We
 * now store just `@username` on bind, but existing bindings carry the legacy
 * value, so normalise defensively on read: pick the `@`-prefixed token when
 * present, otherwise fall back to the raw value.
 */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function normalizeTelegramBotName(raw) {
    if (!raw)
        return undefined;
    const trimmed = raw.trim();
    if (!trimmed)
        return undefined;
    const handleToken = trimmed.split(/\s+/u).find((token) => token.startsWith('@'));
    return handleToken ?? trimmed;
}
//# sourceMappingURL=telegram-events.js.map