import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
/**
 * Inbound ack reactions for Feishu, and the state machine that drives them.
 *
 * The reaction on an inbound message tells the user where that message stands:
 *
 *   | state                              | emoji_type    |
 *   | ---------------------------------- | ------------- |
 *   | received, turn running             | `OnIt` (👀)   |
 *   | queued behind a running turn       | `OneSecond`   |
 *   | queued message starts executing    | back to `OnIt`|
 *   | final reply delivered              | removed       |
 *   | merged into the running turn       | removed       |
 *
 * Every transition is best-effort: a reaction outage must never block or fail
 * a reply, so failures are logged at warn and the store entry is dropped
 * rather than retried with an id that no longer exists.
 */
/** "收到、正在执行". */
export const FEISHU_ACK_EMOJI = 'OnIt';
/**
 * "排队中，稍等".
 *
 * @internal Exported only for focused tests.
 */
export const FEISHU_QUEUED_EMOJI = 'OneSecond';
/**
 * Pending-ack entries older than this are swept (reply never delivered).
 *
 * @internal Exported only for focused tests.
 */
export const PENDING_REACTION_TTL_MS = 24 * 60 * 60_000;
/** Drop entries whose reply never landed, so the map cannot grow unbounded. */
export function sweepExpiredReactions(store, nowMs) {
    for (const [key, entry] of store) {
        if (nowMs - entry.createdAtMs > PENDING_REACTION_TTL_MS)
            store.delete(key);
    }
}
/**
 * Per-message serialization for reaction transitions. A queued notice and a
 * turn start can race; running them one after another keeps "remove old, add
 * new" from interleaving into two live reactions.
 */
const reactionLocks = new Map();
async function withReactionLock(messageId, run) {
    const previous = reactionLocks.get(messageId);
    const result = (async () => {
        if (previous) {
            try {
                await previous;
            }
            catch {
                // A failed transition never blocks the next one.
            }
        }
        return run();
    })();
    reactionLocks.set(messageId, result);
    try {
        return await result;
    }
    finally {
        if (reactionLocks.get(messageId) === result)
            reactionLocks.delete(messageId);
    }
}
/**
 * Revoke the ack reaction after the final reply for `inboundMessageId` has been
 * delivered (or after the message was merged into a running turn).
 *
 *   - missing store / missing inbound id → no-op (nothing to revoke);
 *   - the entry is deleted up-front (success or failure — a failed removal must
 *     not be retried on the next turn with a stale id);
 *   - the actual `remove` call is best-effort: failures are logged at warn (no
 *     message bodies) and never thrown.
 */
export async function removeAckReaction(input) {
    const { store, inboundMessageId } = input;
    if (!store || !inboundMessageId)
        return;
    await withReactionLock(inboundMessageId, async () => {
        const entry = store.get(inboundMessageId);
        if (!entry)
            return;
        store.delete(inboundMessageId);
        try {
            await input.remove(inboundMessageId, entry.reactionId);
            logger.info({ messageId: inboundMessageId, emojiType: entry.emojiType, phase: entry.phase }, 'Feishu ack reaction revoked');
        }
        catch (err) {
            logger.warn({ messageId: inboundMessageId, err: err instanceof Error ? err.message : String(err) }, 'Feishu ack reaction removal failed');
        }
    });
}
/**
 * A queued notice downgrades `OnIt` to `OneSecond`.
 *
 * Skipped when the turn already started (`phase !== 'ack'`): a queued notice
 * that arrives after the message began executing must not claim it is waiting.
 */
export async function markFeishuReactionQueued(input) {
    const { store, inboundMessageId } = input;
    if (!store || !inboundMessageId)
        return;
    await withReactionLock(inboundMessageId, async () => {
        const entry = store.get(inboundMessageId);
        if (!entry)
            return;
        if (entry.phase !== 'ack') {
            logger.info({ messageId: inboundMessageId, phase: entry.phase }, 'Feishu queued reaction switch skipped: turn already started');
            return;
        }
        // Claim the transition before the first await so a concurrent turn start
        // observes `queued` and switches back instead of racing this downgrade.
        store.set(inboundMessageId, { ...entry, phase: 'queued', emojiType: FEISHU_QUEUED_EMOJI });
        await replaceReaction(input, inboundMessageId, entry.reactionId, FEISHU_QUEUED_EMOJI);
    });
}
/**
 * The queued message started executing: `OneSecond` goes back to `OnIt`.
 * An entry still on `ack` is already `OnIt`, so only the phase is recorded —
 * no platform call, and no chance of a duplicate reaction.
 */
export async function markFeishuReactionExecuting(input) {
    const { store, inboundMessageId } = input;
    if (!store || !inboundMessageId)
        return;
    await withReactionLock(inboundMessageId, async () => {
        const entry = store.get(inboundMessageId);
        if (!entry || entry.phase === 'executing')
            return;
        if (entry.phase === 'ack') {
            store.set(inboundMessageId, { ...entry, phase: 'executing' });
            return;
        }
        store.set(inboundMessageId, { ...entry, phase: 'executing', emojiType: FEISHU_ACK_EMOJI });
        await replaceReaction(input, inboundMessageId, entry.reactionId, FEISHU_ACK_EMOJI);
    });
}
/**
 * Remove the reaction we hold and add `emojiType` in its place, then record the
 * new reaction id. When the add fails or yields no id there is nothing left to
 * revoke later, so the entry is dropped instead of keeping a dead id.
 */
async function replaceReaction(input, inboundMessageId, previousReactionId, emojiType) {
    try {
        await input.remove(inboundMessageId, previousReactionId);
    }
    catch (err) {
        logger.warn({
            messageId: inboundMessageId,
            emojiType,
            err: err instanceof Error ? err.message : String(err),
        }, 'Feishu reaction replacement could not remove the previous reaction');
    }
    try {
        const reactionId = await input.add(inboundMessageId, emojiType);
        const current = input.store?.get(inboundMessageId);
        if (!current)
            return;
        if (!reactionId) {
            input.store?.delete(inboundMessageId);
            return;
        }
        input.store?.set(inboundMessageId, { ...current, reactionId });
        logger.info({ messageId: inboundMessageId, emojiType, phase: current.phase }, 'Feishu ack reaction switched');
    }
    catch (err) {
        input.store?.delete(inboundMessageId);
        logger.warn({
            messageId: inboundMessageId,
            emojiType,
            err: err instanceof Error ? err.message : String(err),
        }, 'Feishu reaction replacement failed');
    }
}
//# sourceMappingURL=feishu-reactions.js.map