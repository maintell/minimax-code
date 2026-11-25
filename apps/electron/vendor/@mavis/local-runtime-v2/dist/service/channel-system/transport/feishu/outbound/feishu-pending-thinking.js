/**
 * Entries older than this are swept on insert (their reply never landed and
 * nothing closed them out). The window has to outlast a queue: a message can
 * sit behind a long turn for far more than ten minutes, and sweeping it early
 * would drop the card the queued reply still has to rewrite.
 *
 * @internal Exported only for focused tests.
 */
export const PENDING_THINKING_TTL_MS = 24 * 60 * 60_000;
/** Separator that cannot occur in a Feishu client name or message id. */
const KEY_SEPARATOR = '\u0000';
function cardKey(clientName, inboundMessageId) {
    return `${clientName}${KEY_SEPARATOR}card${KEY_SEPARATOR}${inboundMessageId}`;
}
function chatKey(clientName, chatId, threadId) {
    return `${clientName}${KEY_SEPARATOR}chat${KEY_SEPARATOR}${chatId}${KEY_SEPARATOR}${threadScope(threadId)}`;
}
/** Missing / blank thread → the chat-level scope, identical to a non-topic chat. */
function threadScope(threadId) {
    return threadId?.trim() ?? '';
}
/**
 * Process-local store shared by the WS dispatcher (writer), the outbound
 * client and the platform adapter (consumers). In-memory only: a placeholder
 * card is worthless once the process that rendered it is gone.
 */
export class FeishuPendingThinkingStore {
    nowMs;
    cards = new Map();
    latestInbound = new Map();
    /** `nowMs` drives the TTL sweep only; injectable so tests can pin it. */
    constructor(nowMs = Date.now) {
        this.nowMs = nowMs;
    }
    /** The card rendered for one inbound message, if it has not been consumed. */
    getCard(clientName, inboundMessageId) {
        return this.cards.get(cardKey(clientName, inboundMessageId));
    }
    setCard(clientName, inboundMessageId, card) {
        this.sweepExpired(this.nowMs());
        this.cards.set(cardKey(clientName, inboundMessageId), card);
    }
    deleteCard(clientName, inboundMessageId) {
        this.cards.delete(cardKey(clientName, inboundMessageId));
    }
    /**
     * Newest inbound message id seen in this chat + topic, across both key
     * spaces. `threadId` must be the thread of the message being answered, so a
     * sibling topic's traffic never decides this one's delivery plan.
     */
    getLatestInboundMessageId(clientName, chatId, threadId) {
        return this.latestInbound.get(chatKey(clientName, chatId, threadId))?.messageId;
    }
    setLatestInboundMessageId(clientName, chatId, threadId, inboundMessageId) {
        const nowMs = this.nowMs();
        this.sweepExpired(nowMs);
        this.latestInbound.set(chatKey(clientName, chatId, threadId), {
            messageId: inboundMessageId,
            createdAtMs: nowMs,
        });
    }
    /** Drop entries nothing will ever consume, so neither map grows unbounded. */
    sweepExpired(nowMs) {
        for (const [key, card] of this.cards) {
            if (nowMs - card.createdAtMs > PENDING_THINKING_TTL_MS)
                this.cards.delete(key);
        }
        for (const [key, entry] of this.latestInbound) {
            if (nowMs - entry.createdAtMs > PENDING_THINKING_TTL_MS)
                this.latestInbound.delete(key);
        }
    }
    /** Number of unconsumed placeholder cards; diagnostics and tests only. */
    get size() {
        return this.cards.size;
    }
}
//# sourceMappingURL=feishu-pending-thinking.js.map