/**
 * Telegram outbound client (runner-facing `LocalMultiChannelClient`).
 *
 * Migration copy (MR1): outbound-client half of v1 `channels/telegram.ts`
 * (proposal §4 splits that mixed file). The HTTP Api class stays with v1
 * until the MR3 delivery takeover.
 */
import { detach, settleQuietly } from '../../settle.js';
import { LocalChannelClientUnavailableError, } from '../../ingress/runner.js';
import { prepareChannelOutboundMessage } from '../../delivery/outbound-message.js';
import { sendTelegramQuestionnaireFallback } from './questionnaire/telegram-questionnaire-legacy-delivery.js';
export class LocalTelegramChannelClient {
    outboundStore;
    resolveSend;
    adapter;
    id;
    platform = 'telegram';
    constructor(outboundStore, resolveSend, clientName, 
    /** Delegates questionnaire delivery so pending + callback decoding share one adapter. */
    adapter) {
        this.outboundStore = outboundStore;
        this.resolveSend = resolveSend;
        this.adapter = adapter;
        this.id = clientName.trim();
    }
    /** Per-chat typing-refresh timers; Telegram clears chat actions after ~5s. */
    typingTimers = new Map();
    async sendText(input) {
        return this.sendMessage(input);
    }
    async sendMessage(input) {
        const outbound = prepareChannelOutboundMessage(input);
        try {
            await this.deliver(outbound);
            return this.recordOutbound(outbound, 'sent');
        }
        catch (err) {
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
    /** Start best-effort Telegram typing refresh for a running turn. */
    async notifyTurnStart(ctx) {
        try {
            const resolved = await this.resolveSend(ctx);
            if (!resolved)
                return;
            const { sender, chatId } = resolved;
            await sender.sendChatAction(chatId, 'typing');
            if (!this.typingTimers.has(chatId)) {
                const timer = setInterval(() => {
                    // Best-effort UX signal; a failed chat action is non-actionable.
                    detach(settleQuietly(sender.sendChatAction(chatId, 'typing')));
                }, 4000);
                if (typeof timer.unref === 'function')
                    timer.unref();
                this.typingTimers.set(chatId, timer);
            }
        }
        catch {
            // Best-effort: typing must never surface to the turn.
        }
    }
    /** Stop the typing refresh timer; Telegram auto-expires the last action. */
    async notifyTurnEnd(ctx) {
        try {
            const resolved = await this.resolveSend(ctx);
            const chatId = resolved?.chatId ?? ctx.chatId;
            const timer = this.typingTimers.get(chatId);
            if (timer) {
                clearInterval(timer);
                this.typingTimers.delete(chatId);
            }
        }
        catch {
            // ignore
        }
    }
    /** Deliver through a real SDK sender; a missing or failed edge rejects. */
    async deliver(input) {
        const resolved = await this.resolveSend(input.ctx);
        if (!resolved)
            throw new LocalChannelClientUnavailableError(input.ctx);
        if (input.questionnaire) {
            await this.deliverQuestionnaire(input.ctx, input.text, input.questionnaire, resolved);
            return;
        }
        const { sender, chatId } = resolved;
        const text = input.text?.trim() ?? '';
        if (text) {
            await sender.sendText(chatId, input.text, undefined, input.ctx.threadId);
        }
        for (const att of input.media ?? []) {
            await sender.sendMedia(chatId, att, input.ctx.threadId);
        }
    }
    /**
     * Questionnaire delivery: the bound adapter (pending tracking + callback
     * decoding) wins; the legacy keyboard fallback covers adapterless wiring.
     * The keyboard already carries the question text; never double-post it.
     */
    async deliverQuestionnaire(ctx, text, questionnaire, resolved) {
        if (this.adapter) {
            const result = await this.adapter.sendMessage({ ctx, text, questionnaire });
            if (result.status === 'error')
                throw new Error(result.error ?? 'Telegram delivery failed');
            return;
        }
        await sendTelegramQuestionnaireFallback({
            sender: resolved.sender,
            chatId: resolved.chatId,
            request: questionnaire,
        });
    }
}
//# sourceMappingURL=telegram-outbound-client.js.map