/**
 * Bring a quota-stopped Goal back to life at the time the provider promised.
 *
 * The scheduler owns no state of its own. Every timer it holds is a cache of a
 * `usage_recovery_at_ms` already committed to the Goal row, which is what lets
 * the same code cover both halves of the problem:
 *
 *   - *Running*: a stop arms one timer, and the timer fires at the recovery
 *     time.
 *   - *Restarted or offline*: startup re-reads the rows. A recovery time still
 *     in the future re-arms a timer; one that elapsed while the process was
 *     down is simply overdue and resumes immediately. Nothing expires just
 *     because no process was watching.
 *
 * Safety comes from the store, not from here. Every resume is a guarded write
 * against the exact decision epoch the stop was recorded at, so a Goal that was
 * paused, cleared, replaced, completed, edited into a new epoch or already
 * resumed by hand cannot be restarted by a timer that is still in flight. A
 * fired timer that finds such a row does nothing at all.
 */
import { usageRecoveryDelayMs } from '@mavis/goal';
import { detach } from '../execution/detach.js';
/**
 * Longest single `setTimeout` this scheduler will arm.
 *
 * Node clamps a delay above ~24.8 days to 1ms, which would turn a distant
 * recovery into an immediate one. Re-arming in bounded hops keeps a long or
 * clock-skewed wait correct, and also gives a machine that slept through the
 * recovery time a chance to notice on its next hop.
 */
const MAX_TIMER_SLICE_MS = 5 * 60 * 1_000;
export class GoalUsageRecoveryScheduler {
    deps;
    armed = new Map();
    setTimer;
    clearTimer;
    stopped = false;
    constructor(deps) {
        this.deps = deps;
        this.setTimer = deps.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs));
        this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    }
    /**
     * Reconcile the timer for one Goal against its current state.
     *
     * Called on every observed Goal change, so it must be cheap and idempotent:
     * a Goal that is no longer awaiting recovery loses its timer, and one that is
     * gets exactly one timer for its current epoch.
     */
    sync(goal) {
        if (this.stopped)
            return;
        const delayMs = usageRecoveryDelayMs(goal, this.deps.nowMs());
        if (delayMs === undefined) {
            this.cancel(goal.goalId);
            return;
        }
        const existing = this.armed.get(goal.goalId);
        if (existing &&
            existing.epoch === goal.updatedAt &&
            existing.recoverAtMs === goal.usageRecoveryAtMs) {
            return;
        }
        this.arm(goal, goal.updatedAt, goal.usageRecoveryAtMs, delayMs);
    }
    /** Drop any timer for a Goal that no longer exists. */
    cancel(goalId) {
        const existing = this.armed.get(goalId);
        if (!existing)
            return;
        this.armed.delete(goalId);
        this.clearTimer(existing.handle);
    }
    /**
     * Rebuild every timer from the durable rows, compensating for downtime.
     *
     * This is the restart half of the contract. A recovery time that passed while
     * this process was not running produces a delay of 0, so the Goal resumes on
     * the next tick instead of waiting for a timer that was never armed. Returns
     * the number of Goals scheduled or resumed, for startup diagnostics.
     */
    async recoverFromStore() {
        if (this.stopped)
            return 0;
        const pending = await this.deps.store().listGoalsAwaitingUsageRecovery();
        let handled = 0;
        for (const goal of pending) {
            const delayMs = usageRecoveryDelayMs(goal, this.deps.nowMs());
            if (delayMs === undefined)
                continue;
            handled += 1;
            this.arm(goal, goal.updatedAt, goal.usageRecoveryAtMs, delayMs);
        }
        return handled;
    }
    /** Release every timer; the durable rows keep the schedule. */
    stop() {
        this.stopped = true;
        for (const [goalId] of this.armed)
            this.cancel(goalId);
    }
    /** Test seam: recovery times currently armed, keyed by goal id. */
    armedRecoveryAtMs(goalId) {
        return this.armed.get(goalId)?.recoverAtMs;
    }
    arm(goal, epoch, recoverAtMs, delayMs) {
        this.cancel(goal.goalId);
        const sliceMs = Math.min(delayMs, MAX_TIMER_SLICE_MS);
        const handle = this.setTimer(() => {
            this.armed.delete(goal.goalId);
            if (this.deps.nowMs() < recoverAtMs) {
                // Only part of the wait has elapsed — keep hopping rather than
                // resuming early. Re-reading the clock each hop is also what makes a
                // suspended machine resume promptly instead of overshooting.
                const remainingMs = Math.max(0, recoverAtMs - this.deps.nowMs());
                this.arm(goal, epoch, recoverAtMs, remainingMs);
                return;
            }
            detach(this.fire(goal, epoch));
        }, sliceMs);
        // A pending recovery must not be a reason to keep the process alive; the
        // durable row already guarantees the Goal is picked up on the next start.
        handle.unref?.();
        this.armed.set(goal.goalId, {
            handle,
            sessionId: goal.sessionId,
            epoch,
            recoverAtMs,
        });
    }
    async fire(goal, epoch) {
        if (this.stopped)
            return;
        try {
            const outcome = await this.deps.store().resumeAfterUsageRecoveryAtEpoch({
                goalId: goal.goalId,
                expectedUpdatedAt: epoch,
            });
            if (outcome.status === 'early') {
                // The row's recovery time moved later (a newer stop recorded a longer
                // window under the same epoch). Wait the rest of it out.
                this.arm(goal, epoch, outcome.recoverAtMs, Math.max(0, outcome.recoverAtMs - this.deps.nowMs()));
                return;
            }
            // `stale` is the expected outcome whenever the user got there first; it
            // is the guard doing its job, not an error, so it is silently dropped.
            if (outcome.status !== 'resumed')
                return;
            await this.deps.onResumed(outcome.goal);
        }
        catch (error) {
            this.deps.reportFailure(goal.sessionId, `Goal usage-limit recovery failed: ${this.deps.formatError(error)}`);
        }
    }
}
//# sourceMappingURL=usage-recovery-scheduler.js.map