import { buildQuestionnaireCard, buildReplyCard } from '../cards/feishu-card.js';
import { errorMessage } from '../feishu-adapter-utils.js';
import { markFeishuReactionQueued, removeAckReaction, } from './feishu-reactions.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/** Written over a superseded placeholder card once its reply went out below. */
const SUPERSEDED_CARD_TEXT = '✅ 已回复，见下方';
/** Written over a placeholder card whose message never got any reply at all. */
const UNANSWERED_CARD_TEXT = '已结束，本轮没有回复内容';
/**
 * Written over the placeholder card of a message that was consumed as an
 * ANSWER (a permission or questionnaire reply intercepted before the bridge).
 * Nothing will be sent for it, but the user's input WAS accepted and the turn
 * it answers keeps running — "已结束，本轮没有回复内容" would read as if the
 * answer had been dropped.
 */
const ANSWER_RECEIVED_CARD_TEXT = '✅ 已收到你的回答';
/** Reply card body for a turn that answered with media and no text. */
const MEDIA_ONLY_REPLY_TEXT = '[已发送媒体]';
/**
 * Deliver one outbound message: questionnaire card, media, then the reply
 * card, then the inbound reaction transition. Never throws — the first
 * failure is reported on the result so each caller keeps its own contract.
 */
export async function deliverFeishuReply(deps, input) {
    const anchor = resolveReplyAnchor(input.ctx);
    const plan = planCardDelivery(deps, input, anchor);
    const result = { lastMessageId: '' };
    if (input.questionnaire) {
        await deliverCardPart({
            deps,
            input,
            anchor,
            plan,
            card: buildQuestionnaireCard(input.questionnaire),
            request: input.questionnaire,
            result,
        });
    }
    const mediaDelivered = await deliverMediaParts(deps, input, anchor, result);
    // A media-only reply still has to close out its placeholder card, or the grey
    // "🤔 思考中…" bubble stays in the chat forever. Only when at least one media
    // actually went out: an all-failed send leaves the card and the reaction alone.
    const cardText = input.text.trim() || (mediaDelivered ? MEDIA_ONLY_REPLY_TEXT : '');
    if (cardText && !input.questionnaire) {
        await deliverCardPart({ deps, input, anchor, plan, card: buildReplyCard(cardText), result });
    }
    // Nothing reached the chat (every part failed) → the turn is not answered,
    // so its ack reaction must stay exactly as the user last saw it.
    if (result.lastMessageId)
        await settleInboundReaction(deps, input);
    return result;
}
/**
 * Quote the inbound message this send answers; `undefined` when it has none.
 * Shared with the WS dispatcher so an inbound-side card and an outbound reply
 * can never disagree on where they anchor.
 */
export function resolveReplyAnchor(ctx) {
    const sourceMessageId = ctx.sourceMessageId?.trim();
    if (!sourceMessageId)
        return undefined;
    return { replyToMessageId: sourceMessageId, inThread: Boolean(ctx.threadId) };
}
/**
 * Which placeholder card — if any — this send may rewrite.
 *
 *   - notice for M      → M's own card, patched in place (or a fresh quoted card);
 *   - final reply for M → M's own card patched in place while M is still the
 *     newest inbound message of the chat, otherwise a fresh quoted card (so the
 *     user gets a new-message notification) plus a settled old card.
 */
function planCardDelivery(deps, input, anchor) {
    const inboundMessageId = anchor?.replyToMessageId;
    if (!inboundMessageId || input.replyScope === 'background')
        return { mode: 'none' };
    const store = deps.pendingThinkingStore;
    const card = store?.getCard(deps.clientName, inboundMessageId);
    if (!card)
        return { mode: 'fresh', inboundMessageId };
    if (input.noticeKind) {
        return { mode: 'patch', inboundMessageId, messageId: card.messageId };
    }
    // Scoped to this message's own topic: a newer message in a SIBLING topic of
    // the same chat must not force a fresh quoted card here.
    const latest = store?.getLatestInboundMessageId(deps.clientName, input.ctx.chatId, input.ctx.threadId);
    // An unknown newest message is treated as "still the newest": only a KNOWN
    // newer inbound forces the fresh quoted card, so a chat that never recorded
    // one keeps today's single-bubble behaviour.
    if (latest === undefined || latest === inboundMessageId) {
        return { mode: 'patch', inboundMessageId, messageId: card.messageId };
    }
    return { mode: 'fresh', inboundMessageId, settleMessageId: card.messageId };
}
/** Patch the owned card, else send a fresh quoted card and settle the old one. */
async function deliverCardPart(part) {
    const { deps, input, anchor, plan, card, result } = part;
    try {
        if (plan.mode === 'patch' && (await patchOwnCard(deps, plan, card))) {
            result.lastMessageId = plan.messageId;
            notifyQuestionnaireRendered(deps, part, plan.messageId);
            return;
        }
        const sent = await deps.sender.sendCard(input.ctx.chatId, card, 'chat_id', anchor);
        if (sent?.messageId)
            result.lastMessageId = sent.messageId;
        notifyQuestionnaireRendered(deps, part, sent?.messageId);
        logCardSent(deps, input, anchor, sent?.messageId);
        if (plan.mode === 'fresh')
            await settleSupersededCard(deps, plan);
    }
    catch (err) {
        result.firstError ??= errorMessage(err);
    }
}
/** One line per card send, so a later "which card went where" is answerable. */
function logCardSent(deps, input, anchor, cardMessageId) {
    logger.info({
        decision: anchor ? 'fresh_quoted_card' : 'plain_send',
        clientName: deps.clientName,
        chatId: input.ctx.chatId,
        inboundMessageId: anchor?.replyToMessageId ?? null,
        noticeKind: input.noticeKind ?? null,
        cardMessageId: cardMessageId ?? null,
    }, 'Feishu outbound card sent');
}
/** Consume the pending entry either way; a failed PATCH falls back to a fresh card. */
async function patchOwnCard(deps, plan, card) {
    try {
        await deps.sender.patchCard(plan.messageId, card);
    }
    catch (err) {
        deps.pendingThinkingStore?.deleteCard(deps.clientName, plan.inboundMessageId);
        logger.warn({
            clientName: deps.clientName,
            inboundMessageId: plan.inboundMessageId,
            cardMessageId: plan.messageId,
            err: errorMessage(err),
        }, 'Feishu placeholder card patch failed; sending a fresh quoted card');
        return false;
    }
    deps.pendingThinkingStore?.deleteCard(deps.clientName, plan.inboundMessageId);
    logger.info({
        decision: 'patch_in_place',
        clientName: deps.clientName,
        inboundMessageId: plan.inboundMessageId,
        cardMessageId: plan.messageId,
    }, 'Feishu outbound rewrote its own placeholder card');
    return true;
}
/** Point a superseded placeholder card at the reply that replaced it. */
async function settleSupersededCard(deps, plan) {
    const settleMessageId = plan.settleMessageId;
    if (!settleMessageId)
        return;
    deps.pendingThinkingStore?.deleteCard(deps.clientName, plan.inboundMessageId);
    try {
        await deps.sender.patchCard(settleMessageId, buildReplyCard(SUPERSEDED_CARD_TEXT));
        logger.info({
            decision: 'settled_superseded_card',
            clientName: deps.clientName,
            inboundMessageId: plan.inboundMessageId,
            cardMessageId: settleMessageId,
        }, 'Feishu superseded placeholder card settled');
    }
    catch (err) {
        logger.warn({
            clientName: deps.clientName,
            inboundMessageId: plan.inboundMessageId,
            cardMessageId: settleMessageId,
            err: errorMessage(err),
        }, 'Feishu superseded placeholder card could not be settled');
    }
}
/**
 * Close out the placeholder card of an inbound message that gets no reply of
 * its own — its Turn ended without output, it never became a Turn, or it was
 * consumed as an answer to a pending ask.
 *
 * `kind` picks the terminal text: `'unanswered'` (default) for a message that
 * got nothing at all, `'answered'` for one whose text WAS accepted as a
 * permission / questionnaire reply. Both close the card the same way; only the
 * wording differs, because "no reply content" would misreport an accepted
 * answer as a dropped one.
 *
 * The store is the source of truth, so this is a no-op the moment a reply or a
 * notice already consumed the card. That is what keeps it from racing a
 * delivery that is still to come: callers only reach it once nothing else will
 * be sent for that message. Best-effort — the entry is dropped either way,
 * because nothing will retry a card that is already stale.
 */
export async function settleUnansweredFeishuCard(deps, ctx, kind = 'unanswered') {
    const inboundMessageId = ctx.sourceMessageId?.trim();
    const store = deps.pendingThinkingStore;
    if (!inboundMessageId || !store)
        return;
    const card = store.getCard(deps.clientName, inboundMessageId);
    if (!card)
        return;
    store.deleteCard(deps.clientName, inboundMessageId);
    const cardText = kind === 'answered' ? ANSWER_RECEIVED_CARD_TEXT : UNANSWERED_CARD_TEXT;
    try {
        await deps.sender.patchCard(card.messageId, buildReplyCard(cardText));
        logger.info({
            decision: 'settled_unanswered_card',
            settleKind: kind,
            clientName: deps.clientName,
            inboundMessageId,
            cardMessageId: card.messageId,
        }, 'Feishu unanswered placeholder card closed out');
    }
    catch (err) {
        logger.warn({
            clientName: deps.clientName,
            inboundMessageId,
            cardMessageId: card.messageId,
            err: errorMessage(err),
        }, 'Feishu unanswered placeholder card could not be closed out');
    }
}
/**
 * Media is sent in order; each failure records the first error only. Returns
 * whether at least one attachment actually reached the chat.
 */
async function deliverMediaParts(deps, input, anchor, result) {
    let delivered = false;
    for (const ref of input.media ?? []) {
        try {
            const sent = await deps.sender.sendMedia(input.ctx.chatId, ref, 'chat_id', anchor);
            if (sent?.messageId)
                result.lastMessageId = sent.messageId;
            delivered = true;
        }
        catch (err) {
            result.firstError ??= errorMessage(err);
        }
    }
    return delivered;
}
/**
 * Settle the inbound ack reaction for this send:
 *   - queued notice  → `OnIt` becomes `OneSecond` (never removed);
 *   - steered notice → removed, the "已补充" card is the confirmation;
 *   - final reply    → removed;
 *   - wake reply     → untouched.
 */
async function settleInboundReaction(deps, input) {
    const inboundMessageId = input.ctx.sourceMessageId;
    if (!inboundMessageId || input.replyScope === 'background')
        return;
    const sender = deps.sender;
    if (input.noticeKind === 'queued') {
        await markFeishuReactionQueued({
            store: deps.pendingReactionStore,
            inboundMessageId,
            add: (messageId, emojiType) => sender.addReaction(messageId, emojiType),
            remove: (messageId, reactionId) => sender.removeReaction(messageId, reactionId),
        });
        return;
    }
    await removeAckReaction({
        store: deps.pendingReactionStore,
        inboundMessageId,
        remove: (messageId, reactionId) => sender.removeReaction(messageId, reactionId),
    });
}
function notifyQuestionnaireRendered(deps, part, messageId) {
    const request = part.request;
    if (!request || !messageId)
        return;
    deps.onQuestionnaireRendered?.({ chatId: part.input.ctx.chatId, request, messageId });
}
//# sourceMappingURL=feishu-reply-delivery.js.map