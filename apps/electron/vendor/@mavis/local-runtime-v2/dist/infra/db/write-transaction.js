import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
const WRITE_LOCK_BUDGET_MS = 10_000;
const WRITE_LOCK_ATTEMPT_MS = 50;
/** Cancellation before the mutation callback starts; no write needs to be replayed. */
export class WriteLockWaitAbortedError extends Error {
    signal;
    name = 'WriteLockWaitAbortedError';
    constructor(signal) {
        super('SQLite write lock wait was cancelled', { cause: signal.reason });
        this.signal = signal;
    }
}
/**
 * Retry only transaction admission: a callback that has started is never replayed.
 * The signal cancels contention waits, not an immediately available write. This
 * lets post-cancellation tool completion and cleanup messages remain durable.
 */
export async function runWithWriteLock(db, mutation, options = {}) {
    const budget = options.timeoutMs ?? WRITE_LOCK_BUDGET_MS;
    if (!Number.isFinite(budget) || budget <= 0)
        throw new RangeError('Invalid write lock budget');
    const deadline = performance.now() + budget;
    let attempt = 0;
    let hasContended = false;
    let lastBusy = new Error('SQLite write lock wait exceeded its deadline');
    for (;;) {
        if (hasContended)
            throwIfWaitAborted(options.signal);
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            throw lastBusy;
        const nativeWaitMs = options.signal?.aborted
            ? 0
            : Math.ceil(Math.min(WRITE_LOCK_ATTEMPT_MS, remaining));
        const result = tryWriteTransaction(db, mutation, nativeWaitMs);
        if (result.acquired)
            return result.value;
        lastBusy = result.error;
        hasContended = true;
        throwIfWaitAborted(options.signal);
        const wait = Math.min(deadline - performance.now(), 25 * 2 ** Math.min(attempt++, 3) + Math.random() * 25);
        if (wait <= 0)
            throw lastBusy;
        await waitForRetry(wait, options.signal);
    }
}
function throwIfWaitAborted(signal) {
    if (signal?.aborted)
        throw new WriteLockWaitAbortedError(signal);
}
function isBusy(error) {
    return error instanceof Error && Reflect.get(error, 'code') === 'SQLITE_BUSY';
}
function tryWriteTransaction(db, mutation, nativeWaitMs) {
    const previous = db.get(sql `PRAGMA busy_timeout`).timeout;
    let entered = false;
    try {
        db.run(sql.raw(`PRAGMA busy_timeout = ${nativeWaitMs}`));
        const value = db.transaction((tx) => {
            entered = true;
            // Restore the connection policy before mutations or nested transactions run.
            db.run(sql.raw(`PRAGMA busy_timeout = ${previous}`));
            return mutation(tx);
        }, { behavior: 'immediate' });
        return { acquired: true, value };
    }
    catch (error) {
        if (entered || !isBusy(error))
            throw error;
        return { acquired: false, error };
    }
    finally {
        // No await occurs while the shared connection has a temporary timeout.
        db.run(sql.raw(`PRAGMA busy_timeout = ${previous}`));
    }
}
async function waitForRetry(wait, signal) {
    try {
        await delay(wait, undefined, { signal });
    }
    catch (error) {
        if (signal?.aborted && error instanceof Error && error.name === 'AbortError') {
            throw new WriteLockWaitAbortedError(signal);
        }
        throw error;
    }
}
//# sourceMappingURL=write-transaction.js.map