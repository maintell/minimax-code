/**
 * Inbound identity, slash parsing and payload readers for channel ingress.
 *
 * Migration copy (MR1) of v1 `channels/channel-inbound-utils.ts`, decoupled
 * from the v1 HTTP helpers:
 * - `LOCAL_CHANNEL_SLASH_COMMANDS` moved to `channel-contracts.ts` (single
 *   source of truth for the parser allowlist and the name union);
 * - `readChannelContext` used to return a ready-made 400 `Response`; the v2
 *   copy returns a structured `ChannelWireValidationError` instead, because
 *   the service layer must not construct transport responses. The delivery
 *   layer maps it back to the same HTTP status/JSON shape in MR3.
 */
import { createHash, randomUUID } from 'node:crypto';
import { LOCAL_CHANNEL_SLASH_COMMANDS } from '../channel-contracts.js';
import { readFirstString } from '../record-read.js';
export function parseLocalChannelSlashCommand(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/'))
        return undefined;
    // Tolerate an optional `@botusername` suffix on the command token. Telegram
    // appends it to every command sent in a group chat (`/new@mybot`); Bot API
    // documents commands as `/command@botusername`. Stripping it here keeps slash
    // parsing consistent across all IM platforms and independent of whether the
    // adapter knows the bot's own @-handle.
    const match = trimmed.match(/^\/([a-z][\w-]*)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/iu);
    if (!match)
        return undefined;
    const raw = match[1]?.toLowerCase();
    const args = match[2]?.trim() ?? '';
    if (raw && LOCAL_CHANNEL_SLASH_COMMANDS.includes(raw)) {
        return { name: raw, args };
    }
    return undefined;
}
export function buildLocalChannelBindingKey(ctx) {
    return [
        ctx.platform,
        ctx.clientName,
        ctx.chatId,
        ctx.senderId,
        ctx.threadId ?? '',
        ctx.lane ?? 'interactive',
    ]
        .map((part) => encodeURIComponent(part))
        .join(':');
}
/**
 * Makes a Conversation mutation receipt key from the transport identity that
 * scopes an inbound event. Platform event ids are not globally unique across
 * channel clients or chats, while direct callers may have no event id at all.
 */
export function buildLocalChannelInboundRequestId(ctx, eventId) {
    const sourceId = eventId?.trim() || ctx.sourceMessageId?.trim();
    if (!sourceId)
        return `channel-inbound:${randomUUID()}`;
    return ['channel-inbound', ctx.platform, ctx.clientName, ctx.chatId, sourceId]
        .map((part) => encodeURIComponent(part))
        .join(':');
}
/**
 * Stable correlation key for persistent IM observability. The underlying
 * receipt id includes transport identifiers and must remain private to the
 * mutation protocol, so logs record only this hash.
 */
export function buildLocalChannelInboundRequestKey(ctx, eventId) {
    return hashLocalChannelRequestId(buildLocalChannelInboundRequestId(ctx, eventId));
}
export function hashLocalChannelRequestId(requestId) {
    return createHash('sha256').update(requestId, 'utf8').digest('hex');
}
export function readChannelContext(body) {
    const platform = normalizePlatform(readFirstString(body, ['platform']));
    const chatType = readFirstString(body, ['chatType', 'chat_type']) ?? 'private';
    const chatId = readFirstString(body, ['chatId', 'chat_id', 'channelId', 'channel_id']);
    const senderId = readFirstString(body, ['senderId', 'sender_id', 'userId', 'user_id']);
    if (!platform || !chatId || !senderId) {
        return {
            error: {
                status: 400,
                code: 'VALIDATION_ERROR',
                message: 'platform, chatId, and senderId are required',
            },
        };
    }
    return {
        ctx: {
            platform,
            chatType,
            chatId,
            senderId,
            clientName: readFirstString(body, ['clientName', 'client_name']) ?? '',
            ...(readFirstString(body, ['threadId', 'thread_id'])
                ? { threadId: readFirstString(body, ['threadId', 'thread_id']) }
                : {}),
            ...(readFirstString(body, ['lane']) ? { lane: readFirstString(body, ['lane']) } : {}),
            hasMention: body.hasMention === true || body.mentioned === true,
        },
    };
}
function normalizePlatform(value) {
    if (value === 'feishu' || value === 'telegram' || value === 'wechat')
        return value;
    return undefined;
}
//# sourceMappingURL=channel-inbound-utils.js.map