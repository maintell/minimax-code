/**
 * Migration copy (MR1) of v1 `channels/adapters/feishu/feishu-ws.ts`.
 */
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { buildReplyCard, buildThinkingCard } from './cards/feishu-card.js';
import { isElectronNetFetchByteStringError, resolveInboundAttachments, } from './feishu-inbound-attachments.js';
import { resolveReplyAnchor } from './outbound/feishu-reply-delivery.js';
import { FEISHU_ACK_EMOJI, removeAckReaction, sweepExpiredReactions, } from './outbound/feishu-reactions.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
const FEISHU_RESOURCE_ERROR_REPLY = '抱歉，这个文件暂时没能接收成功。请尝试将文件名中的中文改为英文或数字，保留扩展名后重新发送。';
export async function startFeishuEventDispatcher(input) {
    const sdkSpecifier = '@larksuiteoapi/node-sdk';
    const sdk = (await import(sdkSpecifier));
    const dispatcher = new sdk.EventDispatcher({
        ...(input.record.verificationToken
            ? { verificationToken: input.record.verificationToken }
            : {}),
        ...(input.record.encryptKey ? { encryptKey: input.record.encryptKey } : {}),
    });
    // Per-process dedup of `(eventId | messageId)` seen in the last DEDUP_TTL_MS.
    // Feishu WS occasionally redelivers the same `im.message.receive_v1` (we've
    // observed it after a slow turn) — without dedup we render a second grey
    // "思考中…" card, which never gets patched because the runner short-circuits
    // the duplicated turn on `infra.handleInbound`'s own eventDedupCache.
    const seenKeys = new Map();
    const DEDUP_TTL_MS = 60_000;
    dispatcher.register({
        'im.message.receive_v1': async (data) => {
            const envelope = await input.normalizeInbound(data);
            logger.info({
                chatId: envelope.ctx.chatId,
                messageId: envelope.messageId ?? null,
                eventId: envelope.eventId ?? null,
                attachmentRefs: envelope.attachmentRefs?.length ?? 0,
            }, 'Feishu websocket message received');
            if (isDuplicateWsEvent(envelope, seenKeys, DEDUP_TTL_MS))
                return;
            const text = ensureInboundText(envelope.text, envelope.attachmentRefs);
            const preflight = input.preflightInbound
                ? await input.preflightInbound({
                    ctx: envelope.ctx,
                    text,
                    ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
                })
                : undefined;
            if (preflight && !preflight.allowed)
                return;
            const ack = startInboundAckReaction(input, envelope);
            await postThinkingCard(input, envelope);
            const attachments = await resolveAttachmentsOrReportError(input, envelope, ack);
            if (!attachments)
                return;
            await input.dispatchInbound(buildWsDispatchInput({ envelope, text, attachments, preflight }));
        },
        'card.action.trigger': async (data) => {
            logger.info({}, 'Feishu websocket card action triggered');
            if (!input.onCardAction)
                return {};
            try {
                const result = await input.onCardAction(data);
                return result && typeof result === 'object' ? result : {};
            }
            catch (err) {
                logger.warn({ err }, 'Feishu websocket card action handler failed');
                return {};
            }
        },
    });
    const client = await input.clientFactory();
    const logCtx = input.clientName ? { clientName: input.clientName } : {};
    logger.info(logCtx, 'Feishu WS client starting');
    await client.start({ eventDispatcher: dispatcher });
    logger.info(logCtx, 'Feishu WS client started');
    return client;
}
/**
 * Resolve inbound attachments; the Electron net.fetch ByteString failure is
 * user-reported (resource error reply + ack cleanup) and returns undefined so
 * the caller drops the event instead of dispatching a broken turn.
 */
async function resolveAttachmentsOrReportError(input, envelope, ack) {
    try {
        return await resolveInboundAttachments(envelope, input.attachmentDownloader);
    }
    catch (err) {
        if (!isElectronNetFetchByteStringError(err))
            throw err;
        const anchor = resolveReplyAnchor({
            sourceMessageId: envelope.messageId,
            threadId: envelope.ctx.threadId,
        });
        await handleFeishuResourceError({
            sender: input.sender,
            clientName: resolveStoreClientName(envelope.ctx.clientName, input.clientName),
            chatId: envelope.ctx.chatId,
            ...(anchor ? { anchor } : {}),
            pendingThinkingStore: input.pendingThinkingStore,
            pendingReactionStore: input.pendingReactionStore,
            inboundMessageId: envelope.messageId,
            ackReactionPromise: ack.promise,
            ackReactionId: () => ack.reactionId(),
        });
        return undefined;
    }
}
/** Optional-field assembly for the runner dispatch call. */
function buildWsDispatchInput(build) {
    const { envelope, text, attachments, preflight } = build;
    return {
        ctx: envelope.ctx,
        text,
        ...(envelope.eventId ? { eventId: envelope.eventId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(envelope.quotedMessage ? { quotedMessage: envelope.quotedMessage } : {}),
        ...(preflight?.allowed ? { preflight: preflight.token } : {}),
    };
}
/** Dedup key: prefer eventId, fall back to messageId. TTL sweep is inline. */
function isDuplicateWsEvent(envelope, seenKeys, ttlMs) {
    const dedupKey = envelope.eventId ?? envelope.messageId;
    if (!dedupKey)
        return false;
    const now = Date.now();
    // Sweep old entries cheaply.
    for (const [k, ts] of seenKeys) {
        if (now - ts > ttlMs)
            seenKeys.delete(k);
    }
    if (seenKeys.has(dedupKey)) {
        logger.info({ dedupKey }, 'Feishu websocket duplicate message dropped');
        return true;
    }
    seenKeys.set(dedupKey, now);
    return false;
}
/**
 * Fire-and-track the 👀 `OnIt` inbound ack reaction. Detached on purpose —
 * the ack must never delay dispatch; the resource-error path awaits the
 * tracked promise before cleaning up. Failures only log.
 */
function startInboundAckReaction(input, envelope) {
    let ackReactionId;
    if (!input.sender || !envelope.messageId) {
        return { reactionId: () => undefined };
    }
    const ackMessageId = envelope.messageId;
    const sender = input.sender;
    const run = async () => {
        try {
            const reactionId = await sender.addReaction(ackMessageId, FEISHU_ACK_EMOJI);
            ackReactionId = reactionId;
            const store = input.pendingReactionStore;
            if (!store || !reactionId)
                return;
            // Sweep entries whose reply never delivered (mirrors the WS dedup
            // sweep) so the map cannot grow unbounded.
            const now = Date.now();
            sweepExpiredReactions(store, now);
            store.set(ackMessageId, {
                reactionId,
                createdAtMs: now,
                emojiType: FEISHU_ACK_EMOJI,
                phase: 'ack',
            });
        }
        catch (err) {
            logger.warn({
                chatId: envelope.ctx.chatId,
                err: err instanceof Error ? err.message : String(err),
            }, 'Feishu inbound ack reaction failed');
        }
    };
    return { promise: run(), reactionId: () => ackReactionId };
}
/**
 * Store namespace for one inbound event. The envelope's own `clientName` wins
 * (the adapter stamps it), with the dispatcher's as a fallback for wire shapes
 * that omit it. Several agents share one store, so the key must carry it.
 */
function resolveStoreClientName(ctxClientName, fallback) {
    return ctxClientName?.trim() || fallback?.trim() || '';
}
/**
 * Post one grey "🤔 思考中…" card for THIS inbound message, quoting it.
 *
 * One card per inbound message, not per chat: while an earlier turn is still
 * running the user can send more messages, and each of them gets its own card
 * so a later send can only ever rewrite the card of the message it answers.
 * Best-effort by design — a failed card never blocks dispatch.
 */
async function postThinkingCard(input, envelope) {
    const sender = input.sender;
    const store = input.pendingThinkingStore;
    const chatId = envelope.ctx.chatId;
    const inboundMessageId = envelope.messageId;
    if (!sender || !store || !chatId || !inboundMessageId)
        return;
    const clientName = resolveStoreClientName(envelope.ctx.clientName, input.clientName);
    // The newest inbound message of this chat AND topic decides whether a final
    // reply may still patch its own card in place — a sibling topic's message
    // must not push this one out of its own card.
    store.setLatestInboundMessageId(clientName, chatId, envelope.ctx.threadId, inboundMessageId);
    if (store.getCard(clientName, inboundMessageId))
        return;
    const anchor = resolveReplyAnchor({
        sourceMessageId: inboundMessageId,
        threadId: envelope.ctx.threadId,
    });
    if (!anchor)
        return;
    try {
        const card = buildThinkingCard(input.botName);
        const result = await sender.sendCard(chatId, card, 'chat_id', anchor);
        if (!result?.messageId)
            return;
        store.setCard(clientName, inboundMessageId, {
            messageId: result.messageId,
            createdAtMs: Date.now(),
            inboundMessageId,
        });
        logger.info({
            clientName,
            chatId,
            inboundMessageId,
            cardMessageId: result.messageId,
            inThread: anchor.inThread,
        }, 'Feishu thinking card posted for inbound message');
    }
    catch {
        /* swallow — thinking card is best-effort */
    }
}
async function handleFeishuResourceError(input) {
    const { sender } = input;
    if (!sender)
        return;
    await deliverResourceErrorReply(sender, input);
    await settleAckQuietly(input.ackReactionPromise);
    const reactionId = input.ackReactionId();
    if (!reactionId || !input.inboundMessageId)
        return;
    if (input.pendingReactionStore?.has(input.inboundMessageId)) {
        await removeAckReaction({
            store: input.pendingReactionStore,
            inboundMessageId: input.inboundMessageId,
            remove: (messageId, currentReactionId) => sender.removeReaction(messageId, currentReactionId),
        });
        return;
    }
    try {
        await sender.removeReaction(input.inboundMessageId, reactionId);
    }
    catch (err) {
        logger.warn({
            chatId: input.chatId,
            errorType: err instanceof Error ? err.name : typeof err,
        }, 'Feishu resource error ack cleanup failed');
    }
}
/**
 * PATCH the message's own thinking card into the error reply; else quote it.
 *
 * Deliberately NOT routed through `deliverFeishuReply`: that path asks whether
 * this message is still the newest inbound of the chat and, when it is not,
 * sends a fresh quoted card plus a "已回复，见下方" settle. A resource error is
 * not a reply that went out below — there is nothing below it — so the card is
 * always rewritten in place, and no ack-reaction transition is driven from here.
 */
async function deliverResourceErrorReply(sender, input) {
    const inboundMessageId = input.anchor?.replyToMessageId;
    const pending = inboundMessageId
        ? input.pendingThinkingStore?.getCard(input.clientName, inboundMessageId)
        : undefined;
    if (pending && inboundMessageId) {
        input.pendingThinkingStore?.deleteCard(input.clientName, inboundMessageId);
        try {
            await sender.patchCard(pending.messageId, buildReplyCard(FEISHU_RESOURCE_ERROR_REPLY));
            return;
        }
        catch {
            // Fall through to a quoted reply when the transient card can no longer be patched.
        }
    }
    try {
        await sender.sendText(input.chatId, FEISHU_RESOURCE_ERROR_REPLY, 'chat_id', input.anchor);
    }
    catch (err) {
        logger.warn({
            chatId: input.chatId,
            errorType: err instanceof Error ? err.name : typeof err,
        }, 'Feishu resource error reply failed');
    }
}
/** The ack task logs its own failures; here we only need "it finished". */
async function settleAckQuietly(promise) {
    try {
        await promise;
    }
    catch {
        // already logged inside the ack task
    }
}
function ensureInboundText(text, refs) {
    if (text.trim())
        return text;
    if (!refs || refs.length === 0)
        return text;
    // Empty body + media-only message — feed the agent a stable placeholder so
    // it has *something* to react to. Mirrors historical `lark.ts` behaviour.
    const primary = refs[0];
    if (primary.type === 'image')
        return '[图片]';
    if (primary.type === 'audio')
        return '[语音]';
    if (primary.type === 'video')
        return '[视频]';
    return `[文件] ${primary.name ?? primary.key ?? ''}`.trim();
}
/**
 * Build a {@link FeishuWsAttachmentDownloader} backed by a {@link FeishuSender}.
 * Used by the host wiring to share one sender (token cache + retry policy)
 * between outbound delivery and inbound resource downloads. Writes the bytes
 * under `<dataDir>/tmp/im-attachments/feishu/<sessionId>/<safeName>` and
 * returns the resolved {@link LocalMessageAttachment}.
 *
 * Naming is best-effort: prefers `ref.name`, falls back to `<key><ext>` where
 * `<ext>` is inferred from the ref type (`.png` / `.opus` / `.mp4` / `.bin`).
 * Path separators in `ref.name` are scrubbed to keep the file scope-local.
 */
export function makeFeishuWsAttachmentDownloader(input) {
    return async ({ messageId, ref, sessionId }) => {
        const sender = await input.senderProvider();
        const type = ref.type;
        const buffer = await sender.downloadResource(messageId, ref.key, type);
        const fileName = sanitizeFileName(ref.name ?? `${ref.key}${defaultExt(type)}`, type);
        const dir = join(input.dataDir(), 'tmp', 'im-attachments', 'feishu', sanitizeScope(sessionId));
        await ensureDir(dir);
        const filePath = join(dir, `${messageId}_${fileName}`);
        await writeFile(filePath, buffer);
        return {
            type: type === 'image' ? 'image' : 'file',
            filePath,
            fileName,
            mimeType: ref.mimeType ?? defaultMime(type),
        };
    };
}
function sanitizeFileName(name, type) {
    const cleaned = basename(name)
        .replace(/[/\\?%*:|"<>\s]/gu, '_')
        .slice(0, 120);
    if (cleaned && extname(cleaned))
        return cleaned;
    return `${cleaned || 'attachment'}${defaultExt(type)}`;
}
function sanitizeScope(scope) {
    return scope.replace(/[/\\?%*:|"<>\s]/gu, '_').slice(0, 120) || 'unknown';
}
function defaultExt(type) {
    if (type === 'image')
        return '.png';
    if (type === 'audio')
        return '.opus';
    if (type === 'video')
        return '.mp4';
    return '.bin';
}
function defaultMime(type) {
    if (type === 'image')
        return 'image/png';
    if (type === 'audio')
        return 'audio/opus';
    if (type === 'video')
        return 'video/mp4';
    return 'application/octet-stream';
}
async function ensureDir(dir) {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
}
//# sourceMappingURL=feishu-ws.js.map