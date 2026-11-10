import { settleQuietly } from '../core/settlement.js';
import { settleInBackground } from '../../../infra/async/settle.js';
import { logger } from '@mavis/shared/local-runtime-logging';
import { officialSyncErrorCode } from './sync.js';
/** Failure backoff in seconds; afterwards the normal poll interval resumes. @internal */
export const OFFICIAL_SYNC_BACKOFF_SECONDS = [30, 60, 120, 240, 300];
const DEFAULT_POLL_SECONDS = 900;
const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 24 * 60 * 60;
const SYNC_TIMEOUT_MS = 5 * 60_000;
function defaultTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
}
/**
 * Single-flight scheduler: login ready, auth change, manual "sync now", and the poll timer all
 * funnel into one run. A request during a run marks one follow-up instead of running in parallel.
 */
export class OfficialSyncScheduler {
    options;
    running;
    rerun = false;
    timer;
    failures = 0;
    pollSeconds = DEFAULT_POLL_SECONDS;
    closed = false;
    controller;
    now;
    setTimer;
    constructor(options) {
        this.options = options;
        this.now = options.nowMs ?? Date.now;
        this.setTimer = options.setTimer ?? defaultTimer;
    }
    /** Resolves when the requested (or already running plus follow-up) sync has settled. */
    trigger(reason) {
        if (this.closed)
            return Promise.resolve();
        if (this.running) {
            this.rerun = true;
            return this.running;
        }
        this.timer?.cancel();
        this.timer = undefined;
        const work = this.runLoop(reason);
        this.running = work;
        return work;
    }
    async close() {
        this.closed = true;
        this.timer?.cancel();
        this.timer = undefined;
        this.controller?.abort();
        await settleQuietly(this.running);
    }
    /** Only one loop runs at a time: `trigger` joins it instead of starting another. */
    async runLoop(reason) {
        try {
            await this.loop(reason);
        }
        finally {
            this.running = undefined;
        }
    }
    async loop(reason) {
        let current = reason;
        do {
            this.rerun = false;
            await this.once(current);
            current = 'auth';
        } while (this.rerun && !this.closed);
    }
    async once(reason) {
        if (this.closed)
            return;
        if (!this.options.authenticated()) {
            await this.waitForSignIn();
            return;
        }
        const { ok, errorCode } = await this.attempt();
        if (this.closed)
            return;
        const delaySeconds = this.nextDelaySeconds(ok);
        const at = this.now();
        const nextAt = at + delaySeconds * 1000;
        await this.safeRecord({ success: ok, ...(errorCode ? { errorCode } : {}), at, nextAt });
        if (!ok)
            logger.warn({ event: 'model_access_remote_sync_failed', code: errorCode, trigger: reason }, 'Official model access sync kept the current state');
        this.schedule(delaySeconds * 1000);
    }
    /** Logged out is not a delivery failure: no backoff; the next auth change triggers again. */
    async waitForSignIn() {
        const at = this.now();
        await this.safeRecord({
            success: false,
            errorCode: 'auth_required',
            at,
            nextAt: at + this.pollSeconds * 1000,
        });
        this.schedule(this.pollSeconds * 1000);
    }
    /** One bounded sync; adopts the server's poll interval. */
    async attempt() {
        const controller = new AbortController();
        this.controller = controller;
        const timeout = this.setTimer(() => controller.abort(), SYNC_TIMEOUT_MS);
        try {
            const result = await this.options.run(controller.signal);
            this.pollSeconds = Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, result.pollIntervalSeconds || DEFAULT_POLL_SECONDS));
            const errorCode = result.errorCode ?? (result.deliveryDisabled ? 'delivery_disabled' : undefined);
            return { ok: !result.errorCode, ...(errorCode ? { errorCode } : {}) };
        }
        catch (error) {
            return { ok: false, errorCode: officialSyncErrorCode(error) };
        }
        finally {
            timeout.cancel();
            if (this.controller === controller)
                this.controller = undefined;
        }
    }
    /** Poll interval after success; backoff steps after failures, then the poll interval again. */
    nextDelaySeconds(ok) {
        this.failures = ok ? 0 : this.failures + 1;
        const backoff = OFFICIAL_SYNC_BACKOFF_SECONDS.length;
        const delaySeconds = ok || this.failures > backoff
            ? this.pollSeconds
            : OFFICIAL_SYNC_BACKOFF_SECONDS[this.failures - 1];
        if (this.failures > backoff)
            this.failures = 0;
        return delaySeconds;
    }
    async safeRecord(outcome) {
        try {
            await this.options.record(outcome);
        }
        catch {
            /* Bookkeeping is diagnostic only. */
        }
    }
    schedule(delayMs) {
        if (this.closed)
            return;
        this.timer?.cancel();
        this.timer = this.setTimer(() => {
            this.timer = undefined;
            settleInBackground(this.trigger('timer'));
        }, delayMs);
    }
}
//# sourceMappingURL=scheduler.js.map