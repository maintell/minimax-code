import { settleInBackground } from '../../plugin-system-helpers.js';
/**
 * A marketplace syncs at most once per this interval, manual refreshes included.
 * @internal Exported for focused auto-sync timing tests.
 */
export const AUTO_SYNC_MIN_INTERVAL_MS = 10 * 60_000;
/** @internal Exported for focused auto-sync timing tests. */
export const AUTO_SYNC_FIRST_TICK_MS = 30_000;
const TICK_INTERVAL_MS = 60_000;
/**
 * Background sync of marketplaces with auto-update enabled. Failed attempts
 * also count toward the interval, so an unreachable host is not polled on
 * every tick. Failures only reach `onError` (logs and metrics).
 */
export class AutoUpdater {
    target;
    options;
    timer;
    running;
    stopped = false;
    lastAttemptAt = new Map();
    constructor(target, options) {
        this.target = target;
        this.options = options;
    }
    start() {
        if (this.timer || this.stopped)
            return;
        this.schedule(AUTO_SYNC_FIRST_TICK_MS);
    }
    /** Stops scheduling and waits for a sync already in progress. */
    async dispose() {
        this.stopped = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        await this.running;
    }
    schedule(delayMs) {
        this.timer = setTimeout(() => {
            this.running = this.tick();
            settleInBackground(this.running);
        }, delayMs);
        // Background sync never keeps the host process alive.
        this.timer.unref();
    }
    async tick() {
        try {
            for (const candidate of await this.target.candidates()) {
                if (this.stopped)
                    return;
                await this.syncWhenDue(candidate);
            }
        }
        catch (error) {
            this.options.onError(error);
        }
        finally {
            if (!this.stopped)
                this.schedule(TICK_INTERVAL_MS);
        }
    }
    async syncWhenDue(candidate) {
        const now = this.options.now();
        const last = Math.max(candidate.lastSyncedAtMs ?? 0, this.lastAttemptAt.get(candidate.name) ?? 0);
        if (now - last < AUTO_SYNC_MIN_INTERVAL_MS)
            return;
        this.lastAttemptAt.set(candidate.name, now);
        try {
            await this.target.sync(candidate.name);
        }
        catch (error) {
            this.options.onError(error);
        }
    }
}
//# sourceMappingURL=auto-updater.js.map