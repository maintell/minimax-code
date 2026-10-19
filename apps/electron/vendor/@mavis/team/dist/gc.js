/**
 * PlanGc — background garbage collector for terminal team plans.
 *
 * Mental model:
 *   - Active plans (planning / approved / running / paused) are NEVER touched.
 *   - Pinned plans are NEVER touched, regardless of status.
 *   - Terminal plans (completed / failed / cancelled) past the TTL (default
 *     14 days from `state.updated_at`) are physically deleted.
 *
 * Why a TTL: completed/failed/cancelled plans accumulate quickly during
 * heavy team usage. Each plan dir holds plan.yaml, state.json, board.md,
 * outputs/* (deliverables, verifier feedback) and workspace/* (intermediate
 * artifacts). Without GC the plans/ tree grows unbounded.
 *
 * Why we re-read state right before deleting: the scan -> delete loop is not
 * instantaneous. Between deciding "plan p1 is GC-eligible" and `delete(p1)`,
 * the owner could have restarted the plan or otherwise mutated the state. A
 * fresh getState + isTerminal + age check gates the actual delete to avoid
 * clobbering live work.
 *
 * Scheduling:
 *   - One tick on `start()` so newly-eligible plans get cleaned promptly
 *     after a daemon restart.
 *   - Then every `intervalMs` (default 6h) via setInterval.
 *   - `setTimeout/setInterval` handles are `unref()`ed so they don't block
 *     daemon shutdown.
 *
 * Disable switch:
 *   - Setting `MAVIS_TEAM_GC_DISABLE=1` (checked at construction time) makes
 *     `start()` log a warning and return without scheduling anything.
 */
import { backgroundCtx, logger } from './host-utils.js';
const DEFAULT_TTL_DAYS = 14;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export class PlanGc {
    plansDir;
    store;
    timer;
    ttlMs;
    intervalMs;
    disabled;
    now;
    constructor(plansDir, store, options = {}) {
        this.plansDir = plansDir;
        this.store = store;
        this.ttlMs = (options.ttlDays ?? DEFAULT_TTL_DAYS) * MS_PER_DAY;
        this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
        // Env check happens at construction — start() reuses the cached flag so
        // the disable signal is consistent for the lifetime of the GC instance.
        this.disabled = options.disabled ?? process.env.MAVIS_TEAM_GC_DISABLE === '1';
        this.now = options.now ?? Date.now;
    }
    /** Initial sweep + recurring schedule. No-op if disabled. */
    start() {
        const ctx = backgroundCtx();
        if (this.disabled) {
            logger.warn(ctx, '[team-gc] disabled via MAVIS_TEAM_GC_DISABLE=1 — no automatic plan cleanup will happen');
            return;
        }
        logger.info(ctx, `[team-gc] started: plansDir=${this.plansDir} ttlDays=${this.ttlMs / MS_PER_DAY} intervalMs=${this.intervalMs}`);
        // Run an immediate tick so cold-start cleanup happens before the first
        // interval delay. Errors are logged but never crash — GC must never take
        // down the daemon.
        this.safeTick();
        this.timer = setInterval(() => this.safeTick(), this.intervalMs);
        if (typeof this.timer.unref === 'function')
            this.timer.unref();
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }
    /**
     * One scan-and-delete pass. Public so tests / admin endpoints can trigger
     * a sweep on demand. Errors deleting individual plans are logged and
     * skipped — one bad plan must not block the rest.
     */
    tick() {
        const ctx = backgroundCtx();
        const deleted = [];
        const skipped = [];
        // Snapshot the candidate list once. We re-read state per-plan inside the
        // loop to defend against owner mutations during the sweep.
        const candidates = this.store.listAll();
        const nowMs = this.now();
        for (const candidate of candidates) {
            // Race-defense: re-read state right before deleting. A plan that was
            // GC-eligible at scan time may have been restarted between here and
            // delete. Anything other than a fresh terminal+old tuple is a hard skip.
            const fresh = this.store.getState(candidate.plan_id);
            if (!fresh) {
                // Already gone — count as skipped, not deleted.
                skipped.push(candidate.plan_id);
                continue;
            }
            const decision = this.evaluate(fresh, nowMs);
            if (decision.action !== 'delete') {
                skipped.push(candidate.plan_id);
                continue;
            }
            try {
                const removed = this.store.delete(candidate.plan_id);
                if (removed) {
                    deleted.push(candidate.plan_id);
                    logger.info(ctx, `[team-gc] removing planId=${candidate.plan_id} reason=${decision.reason}`);
                }
                else {
                    skipped.push(candidate.plan_id);
                }
            }
            catch (err) {
                skipped.push(candidate.plan_id);
                logger.warn(ctx, `[team-gc] delete failed planId=${candidate.plan_id} err=${err.message}`);
            }
        }
        return { deleted, skipped };
    }
    /**
     * Decide whether a single plan is GC-eligible. Pure function — no I/O.
     * Exposed so tests (and future admin tooling) can introspect decisions
     * without driving the actual filesystem.
     */
    evaluate(state, nowMs = this.now()) {
        if (!this.store.isTerminal(state)) {
            return { action: 'keep', reason: `non_terminal_status=${state.status}` };
        }
        const updatedMs = state.updated_at;
        if (!Number.isFinite(updatedMs)) {
            // Bad timestamp → keep. A corrupt updated_at is more likely a bug than
            // a real "this plan is infinitely old" — never delete from a parse error.
            return { action: 'keep', reason: 'invalid_updated_at' };
        }
        const ageMs = nowMs - updatedMs;
        if (ageMs < this.ttlMs) {
            const ageDays = Math.floor(ageMs / MS_PER_DAY);
            return { action: 'keep', reason: `${state.status}_age=${ageDays}d_under_ttl` };
        }
        const ageDays = Math.floor(ageMs / MS_PER_DAY);
        return { action: 'delete', reason: `${state.status}_age=${ageDays}d` };
    }
    /** Path used in log lines / error messages — unused internally. */
    describePlanDir(planId) {
        return `${this.plansDir.replace(/[/\\]+$/, '')}/${planId}`;
    }
    safeTick() {
        const ctx = backgroundCtx();
        try {
            const result = this.tick();
            if (result.deleted.length > 0) {
                logger.info(ctx, `[team-gc] sweep done: deleted=${result.deleted.length} skipped=${result.skipped.length}`);
            }
        }
        catch (err) {
            logger.warn(ctx, `[team-gc] tick failed err=${err.message}`);
        }
    }
}
//# sourceMappingURL=gc.js.map