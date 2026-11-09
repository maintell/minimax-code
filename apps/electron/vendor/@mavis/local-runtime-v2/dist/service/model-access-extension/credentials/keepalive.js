import { settleQuietly } from '../core/settlement.js';
import { errorCode } from '../core/context.js';
/**
 * Keeping idle direct sign-ins alive. Ported in part from an MIT-licensed project (see
 * THIRD_PARTY_NOTICES.md): a backup account
 * that waits its turn for days is renewed about once a day, so its refresh token does not lapse
 * just when it is needed. A borrowed sign-in is never renewed here: its refresh token belongs to
 * another application on this computer.
 * @internal Exported for focused tests.
 */
export const MODEL_ACCESS_KEEPALIVE_EVERY_MS = 24 * 60 * 60_000;
/** The first check a minute after start, then hourly (a computer that slept catches up). @internal */
export const MODEL_ACCESS_KEEPALIVE_FIRST_MS = 60_000;
/** @internal Exported for focused tests. */
export const MODEL_ACCESS_KEEPALIVE_INTERVAL_MS = 60 * 60_000;
export class ModelAccessKeepAlive {
    host;
    options;
    timer;
    controller = new AbortController();
    running;
    closed = false;
    /** Sign-ins the vendor refused, by key at the identity revision refused (until a new login). */
    lapsed = new Map();
    constructor(host, options = {}) {
        this.host = host;
        this.options = options;
    }
    start() {
        if (this.closed || this.timer || this.running)
            return;
        this.schedule(this.options.firstMs ?? MODEL_ACCESS_KEEPALIVE_FIRST_MS);
    }
    schedule(delay) {
        if (this.closed)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.running = this.runScheduled();
        }, delay);
        this.timer.unref?.();
    }
    async runScheduled() {
        try {
            await this.runOnce();
        }
        finally {
            this.running = undefined;
            this.schedule(this.options.intervalMs ?? MODEL_ACCESS_KEEPALIVE_INTERVAL_MS);
        }
    }
    /** The direct sign-ins due: renewable, usable, not renewed (or signed in) for a day. */
    due() {
        const now = (this.options.now ?? Date.now)();
        const every = this.options.everyMs ?? MODEL_ACCESS_KEEPALIVE_EVERY_MS;
        return this.host.bindings().filter((binding) => {
            if (binding.kind !== 'direct-owned')
                return false;
            const lapsed = this.lapsed.get(binding.providerKey);
            if (lapsed !== undefined && lapsed === binding.identityRevision)
                return false;
            // updatedAt is the last commit or renewal write, by any caller (a request included).
            return now - binding.updatedAt >= every && this.host.usable(binding);
        });
    }
    /** One pass, one account at a time; failures keep the old credential and are only logged. */
    async runOnce() {
        for (const binding of this.due()) {
            if (this.closed)
                return;
            try {
                await this.host.renew(binding, this.controller.signal);
                this.lapsed.delete(binding.providerKey);
            }
            catch (error) {
                if (this.closed)
                    return;
                const code = errorCode(error) ?? 'renewal_failed';
                if (code === 'request_signin_revoked')
                    this.lapsed.set(binding.providerKey, binding.identityRevision);
                this.host.warn?.({ event: 'model_access_keepalive_failed', code: code.slice(0, 64) }, 'Keeping an idle sign-in renewed failed');
            }
        }
    }
    /** Stops the timer and the pass in progress (an exchange already sent still writes). */
    async close() {
        this.closed = true;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        this.controller.abort();
        await settleQuietly(this.running);
    }
}
//# sourceMappingURL=keepalive.js.map