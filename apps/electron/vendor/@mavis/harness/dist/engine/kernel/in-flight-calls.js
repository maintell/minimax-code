/** Rejection of `run` or `compact` once `lifecycle.close()` has started. */
export class HarnessClosedError extends Error {
    entry;
    constructor(entry) {
        super(`Harness is closed; ${entry} was rejected.`);
        this.entry = entry;
        this.name = 'HarnessClosedError';
    }
}
/**
 * Admits runs and compactions until close starts and keeps the ones in flight,
 * so close can wait for them before the instance releases what it owns.
 */
export class InFlightCalls {
    pending = new Set();
    closing;
    /** Starts `call` unless close has started; a closed instance rejects without calling it. */
    admit(entry, call) {
        if (this.closing)
            return Promise.reject(new HarnessClosedError(entry));
        return this.track(call());
    }
    /**
     * Stops admission, waits for the calls in flight (at most `drainTimeoutMs`
     * when set; 0 does not wait) and then runs `release`. Calls still running
     * at that point are not awaited. Every call returns the first call's Promise.
     */
    close(release, drainTimeoutMs) {
        this.closing ??= this.drainAndRelease(release, drainTimeoutMs);
        return this.closing;
    }
    /** Keeps `call` in `pending` until it settles; its outcome passes through unchanged. */
    async track(call) {
        this.pending.add(call);
        try {
            return await call;
        }
        finally {
            this.pending.delete(call);
        }
    }
    async drainAndRelease(release, timeoutMs) {
        await this.drain(timeoutMs);
        await release();
    }
    async drain(timeoutMs) {
        if (timeoutMs !== undefined && timeoutMs <= 0)
            return;
        const settled = Promise.allSettled(this.pending);
        if (timeoutMs === undefined) {
            await settled;
            return;
        }
        let timer;
        const expired = new Promise((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
        });
        try {
            await Promise.race([settled, expired]);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
//# sourceMappingURL=in-flight-calls.js.map