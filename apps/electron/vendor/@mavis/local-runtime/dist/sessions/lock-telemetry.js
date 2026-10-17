/**
 * `LocalSessionLockTelemetry` — session-lock acquire / renew / release /
 * read failure reporting bundled in one place.
 *
 * The 3 host wrappers (`renewSessionTurnLock`, `isSessionLockedByOtherOwner`,
 * `reportSessionLockReleaseFailure`) and the underlying
 * `reportPiTurnFailure` telemetry call were a tiny cluster duplicated
 * around `api/host.ts` — same try/catch, same failure-string
 * prefix scheme, same `formatUnknownError` plumbing. Pulling them into a
 * narrow helper class keeps the host focused on routing and leaves a
 * stable target for future lock-related diagnostics (renewal interval
 * telemetry, contention metrics) without further host bloat.
 *
 * The class deliberately does NOT own the lock store itself — the host
 * still constructs `SqliteLocalSessionLockStore` and owns its lifecycle.
 * This is just a soft-failure-reporting facade around the 4 read/write
 * call shapes the host actually needs.
 */
export class LocalSessionLockTelemetry {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** Acquires, renews and releases one owner lock while reporting soft failures. */
    async acquireWithRenewal(sessionId, renewalIntervalMs, onLost) {
        const acquired = await this.deps.sessionLocks().acquire(sessionId, this.deps.lockOwner);
        if (!acquired)
            return undefined;
        let lost = false;
        const renewal = setInterval(() => {
            void this.renew(sessionId).then((renewed) => {
                if (renewed || lost)
                    return;
                lost = true;
                onLost();
            });
        }, renewalIntervalMs);
        renewal.unref?.();
        return async () => {
            clearInterval(renewal);
            try {
                await this.deps.sessionLocks().release(sessionId, this.deps.lockOwner);
            }
            catch (err) {
                this.reportReleaseFailure(sessionId, err);
            }
        };
    }
    /**
     * Reacquire the lock for a session (renewal path). Returns `false`
     * when the store throws — the host treats this as "lost the lock"
     * and stops accepting work on the session.
     */
    async renew(sessionId) {
        try {
            return await this.deps.sessionLocks().acquire(sessionId, this.deps.lockOwner);
        }
        catch (err) {
            this.deps.reportFailure(sessionId, `local_session_lock_renewal_failed:${this.deps.formatError(err)}`);
            return false;
        }
    }
    /**
     * Returns true iff some other runtime process owns the lock right
     * now. On a read failure we default to `true` (refuse to act) — a
     * conservative bias that prevents a corrupted lock table from racing
     * two processes into the same session.
     */
    async isHeldByOther(sessionId) {
        try {
            return await this.deps.sessionLocks().isLockedByOtherOwner(sessionId, this.deps.lockOwner);
        }
        catch (err) {
            this.deps.reportFailure(sessionId, `local_session_lock_read_failed:${this.deps.formatError(err)}`);
            return true;
        }
    }
    /**
     * Surface a release failure with a consistent prefix. Called by the
     * deferred `releaseSessionLock` thunk wrapper in the host so a single
     * concept owns the message format.
     */
    reportReleaseFailure(sessionId, err) {
        this.deps.reportFailure(sessionId, `local_session_lock_release_failed:${this.deps.formatError(err)}`);
    }
}
//# sourceMappingURL=lock-telemetry.js.map