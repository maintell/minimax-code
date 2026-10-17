import { logger, backgroundCtx } from './host-utils.js';
/** TTL for queued entries — 30 minutes */
export const TTL_MS = 30 * 60 * 1000;
/**
 * Busy-queue for cron messages when the target session is busy.
 *
 * Latest-wins dedup: per cron per session, only the last enqueued message is kept.
 * Key format: `${sessionId}:${agentName}:${cronName}`.
 *
 * Entries older than TTL_MS are discarded on drain.
 */
export class BusyQueue {
    queue = new Map();
    key(sessionId, agentName, cronName) {
        return `${sessionId}:${agentName}:${cronName}`;
    }
    enqueue(sessionId, agentNameOrCronName, cronNameOrSendFn, maybeSendFn) {
        const legacySignature = typeof cronNameOrSendFn === 'function';
        const agentName = legacySignature ? '' : agentNameOrCronName;
        const cronName = legacySignature ? agentNameOrCronName : cronNameOrSendFn;
        const sendFn = legacySignature ? cronNameOrSendFn : maybeSendFn;
        if (typeof cronName !== 'string' || !sendFn)
            return Promise.resolve('removed');
        const k = this.key(sessionId, agentName, cronName);
        this.queue.get(k)?.resolveDrain('replaced');
        return new Promise((resolveDrain) => {
            this.queue.set(k, {
                sendFn,
                enqueuedAt: Date.now(),
                agentName,
                cronName,
                sessionId,
                resolveDrain,
            });
        });
    }
    /**
     * Drop queued messages for a deleted cron task. Timers are stopped by the
     * registry, but a tick that already entered BusyQueue must be cancelled too;
     * otherwise it can drain after deletion and look like the cron kept running.
     */
    removeCron(agentName, cronName) {
        let removed = 0;
        for (const [k, entry] of this.queue) {
            if (entry.agentName === agentName && entry.cronName === cronName) {
                this.queue.delete(k);
                entry.resolveDrain('removed');
                removed += 1;
            }
        }
        return removed;
    }
    /**
     * Drain all queued entries for a session.
     * Skips expired entries (older than TTL_MS).
     * Each sendFn is wrapped in try/catch so one failure doesn't block others.
     * All entries for the session are removed after drain (including expired).
     */
    async drain(sessionId) {
        const ctx = backgroundCtx();
        const now = Date.now();
        const toExecute = [];
        const toRemove = [];
        for (const [k, entry] of this.queue) {
            if (entry.sessionId === sessionId) {
                toRemove.push(k);
                if (now - entry.enqueuedAt < TTL_MS) {
                    toExecute.push(entry);
                }
                else {
                    entry.resolveDrain('expired');
                    logger.debug(ctx, `[cron] Discarding expired queued entry: sessionId=${sessionId} cronName=${entry.cronName}`);
                }
            }
        }
        // Remove all entries for this session (both valid and expired)
        for (const k of toRemove) {
            this.queue.delete(k);
        }
        // Execute surviving entries
        for (const entry of toExecute) {
            try {
                await entry.sendFn();
                entry.resolveDrain('sent');
                logger.info(ctx, `[cron] Drained queued message to now-idle session: sessionId=${sessionId} cronName=${entry.cronName}`);
            }
            catch (err) {
                entry.resolveDrain('failed');
                logger.error(ctx, `[cron] Failed to drain queued message: sessionId=${sessionId} cronName=${entry.cronName} err=${err.message}`);
            }
        }
    }
    /** Total entries in the queue */
    size() {
        return this.queue.size;
    }
    /** Entries queued for a specific session */
    getQueuedCount(sessionId) {
        let count = 0;
        for (const entry of this.queue.values()) {
            if (entry.sessionId === sessionId)
                count++;
        }
        return count;
    }
}
//# sourceMappingURL=busy-queue.js.map