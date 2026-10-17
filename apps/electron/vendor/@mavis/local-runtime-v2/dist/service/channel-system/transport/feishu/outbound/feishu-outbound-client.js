import { LocalChannelClientUnavailableError, } from '../../../ingress/runner.js';
import { prepareChannelOutboundMessage } from '../../../delivery/outbound-message.js';
import { isUsableFeishuBinding } from '../feishu-adapter-utils.js';
import { buildReplyCard, buildQuestionnaireCard } from '../cards/feishu-card.js';
import { FeishuSender } from './feishu-sender.js';
import { removeAckReaction, } from '../feishu-ws.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
export class LocalFeishuChannelClient {
    id;
    platform = 'feishu';
    sender;
    senderFor;
    outboundStore;
    store;
    defaultAgentName;
    senderOptions;
    pendingThinkingStore;
    /**
     * Shared store of pending 👀 `OnIt` ack reactions (keyed by inbound
     * messageId). Written by the WS dispatcher; consumed here to revoke the
     * ack once the final reply / questionnaire has been delivered.
     */
    pendingReactionStore;
    onQuestionnaireRendered;
    constructor(options) {
        this.outboundStore = options.outboundStore;
        this.store = options.store;
        this.defaultAgentName = options.defaultAgentName;
        this.senderOptions = options.senderOptions ?? {};
        this.pendingThinkingStore = options.pendingThinkingStore;
        this.pendingReactionStore = options.pendingReactionStore;
        this.onQuestionnaireRendered = options.onQuestionnaireRendered;
        this.id = options.clientName?.trim() || options.defaultAgentName.trim() || 'feishu-local';
    }
    sendText(input) {
        return this.sendMessage(input);
    }
    async sendMessage(input) {
        const outbound = prepareChannelOutboundMessage(input);
        try {
            const record = await this.requireRealBinding(outbound.ctx);
            await this.deliver(outbound, record);
            return this.recordOutbound(outbound, 'sent');
        }
        catch (err) {
            // An audit failure is retained as an error, but the SDK/credential
            // failure remains observable to the runner. Never fabricate `sent` for
            // a missing exact edge or an unsuccessful platform call.
            await this.recordOutbound(outbound, 'error', 'CHANNEL_DELIVERY_FAILED');
            throw err;
        }
    }
    recordOutbound(input, status, error = input.error) {
        return this.outboundStore.append({
            ctx: input.ctx,
            text: input.text,
            status,
            ...(input.media && input.media.length > 0 ? { media: input.media } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
            ...(error ? { error } : {}),
        });
    }
    async requireRealBinding(ctx) {
        const record = await this.store.get(agentNameFromContext(ctx, this.defaultAgentName));
        if (!isUsableFeishuBinding(record)) {
            throw new LocalChannelClientUnavailableError(ctx);
        }
        return record;
    }
    async deliver(input, record) {
        const sender = this.ensureSender(record);
        const chatId = input.ctx.chatId;
        // Inbound message id anchoring this turn. Doubles as (a) the thread-reply
        // anchor and (b) the key whose 👀 `OnIt` ack reaction gets revoked once
        // the final reply is delivered. MUST be resolved before the questionnaire
        // path deletes the pending thinking card below.
        const ackMessageId = input.ctx.sourceMessageId ?? this.pendingThinkingStore?.get(chatId)?.inboundMessageId;
        const revokeAckReaction = () => removeAckReaction({
            store: this.pendingReactionStore,
            inboundMessageId: ackMessageId,
            remove: (m, r) => sender.removeReaction(m, r),
        });
        // Thread-aware reply: when the inbound message lived inside a Feishu
        // thread/topic (`ctx.threadId` set), route fresh sends through the `reply`
        // endpoint anchored on a message ID inside that thread so the reply lands
        // in-thread. PATCH-into-final paths keep their own message ID and need no
        // anchor. Prefer the triggering message ID; fall back to the pending
        // thinking card's inbound message ID.
        const thread = input.ctx.threadId && ackMessageId ? { replyToMessageId: ackMessageId } : undefined;
        // Card 2.0 form questionnaire — when present, it must be rendered as
        // the first interactive bubble. Feishu Card 2.0 form already carries the
        // question text inside the card — never double-post a tail reply card on
        // the questionnaire path; skip the legacy text/media tail entirely.
        if (input.questionnaire) {
            await this.deliverQuestionnaireCard({
                questionnaire: input.questionnaire,
                sender,
                chatId,
                thread,
                revokeAckReaction,
            });
            return;
        }
        await this.deliverTextAndMedia({ input, sender, chatId, thread, revokeAckReaction });
    }
    /** Legacy text/media tail: media first, then PATCH-or-fresh final reply card. */
    async deliverTextAndMedia(tail) {
        const { input, sender, chatId, thread, revokeAckReaction } = tail;
        const hasMedia = !!input.media?.length;
        const hasText = input.text.trim().length > 0;
        if (!hasMedia && !hasText)
            return;
        // Send all media before the tail reply. A failed SDK call rejects the
        // delivery so audit state cannot claim a complete real-platform send.
        for (const ref of input.media ?? []) {
            await sender.sendMedia(chatId, ref, 'chat_id', thread);
        }
        const finalText = input.text.trim() || (hasMedia ? '[已发送媒体]' : '');
        if (await this.patchPendingThinkingCard(sender, chatId, finalText)) {
            // Final reply patched in place — revoke the 👀 inbound ack reaction.
            await revokeAckReaction();
            return;
        }
        if (finalText) {
            await sender.sendCard(chatId, buildReplyCard(finalText), 'chat_id', thread);
            // Final reply delivered as a fresh card — revoke the 👀 inbound ack.
            await revokeAckReaction();
        }
    }
    /**
     * PATCH the pending "🤔 思考中…" card into the final reply when one exists.
     * A failed PATCH falls back to a fresh card (grey card may stay orphaned).
     */
    async patchPendingThinkingCard(sender, chatId, finalText) {
        const pending = this.pendingThinkingStore?.get(chatId);
        if (!pending)
            return false;
        this.pendingThinkingStore?.delete(chatId);
        try {
            await sender.patchCard(pending.messageId, buildReplyCard(finalText || ' '));
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Render the Card 2.0 questionnaire: consume any pending "🤔 思考中…" card
     * via PATCH so the chat stays at one bubble per turn, else send fresh.
     * Mirror of the adapter sendMessage path so the runner outbound surface
     * stays the single source of truth.
     */
    async deliverQuestionnaireCard(render) {
        const { questionnaire, sender, chatId, thread } = render;
        const card = buildQuestionnaireCard(questionnaire);
        let messageId;
        const pending = this.pendingThinkingStore?.get(chatId);
        logger.info({
            requestId: questionnaire.id,
            chatId,
            pendingThinkingMsgId: pending?.messageId ?? null,
        }, 'Feishu questionnaire delivery started');
        if (pending) {
            this.pendingThinkingStore?.delete(chatId);
            try {
                await sender.patchCard(pending.messageId, card);
                messageId = pending.messageId;
                logger.info({ messageId: pending.messageId }, 'Feishu questionnaire patched thinking card');
            }
            catch {
                /* patch failed — fall through to a fresh card send */
            }
        }
        if (!messageId) {
            const result = await sender.sendCard(chatId, card, 'chat_id', thread);
            messageId = result?.messageId;
            logger.info({ messageId: messageId ?? null }, 'Feishu questionnaire sent fresh card');
        }
        if (messageId) {
            this.onQuestionnaireRendered?.({
                chatId,
                request: questionnaire,
                messageId,
                clientName: this.id,
            });
            // Questionnaire delivered — revoke the 👀 inbound ack reaction.
            await render.revokeAckReaction();
        }
    }
    ensureSender(record) {
        if (this.sender &&
            this.senderFor?.appId === record.appId &&
            this.senderFor.appSecret === record.appSecret) {
            return this.sender;
        }
        this.sender?.invalidateToken();
        this.sender = new FeishuSender(record.appId, record.appSecret, {
            ...this.senderOptions,
            clientName: this.id,
        });
        this.senderFor = { appId: record.appId, appSecret: record.appSecret };
        return this.sender;
    }
}
function agentNameFromContext(ctx, fallback) {
    const name = ctx.clientName.trim();
    if (!name || name.startsWith('platform:') || name === 'feishu-local')
        return fallback;
    return name;
}
//# sourceMappingURL=feishu-outbound-client.js.map