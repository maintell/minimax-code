import { normalizeUsageRecoveryAtMs } from '@mavis/goal';
/**
 * Keeps the automatic-recovery schedule alive across a manual resume that
 * fails on the same quota (spec §7).
 *
 * A manual resume before the recorded reset time is a real attempt: the Goal
 * goes `active` and its schedule leaves the row. When that attempt's Goal Turn
 * hits the quota again and the provider does not say a new reset time, the Goal
 * returns to `usage_limited` with the schedule it had — a fresh trusted time
 * from the new error still wins. Only the Turns bound at the resumed epoch can
 * claim it, so a later, unrelated quota stop never inherits it.
 *
 * In memory on purpose: a restart aborts the attempt's Turn, and the worst
 * outcome is the pre-existing one — the stop records no schedule and the Goal
 * waits for a manual resume.
 */
export class GoalUsageRecoveryRetention {
    nowMs;
    retained = new Map();
    constructor(nowMs) {
        this.nowMs = nowMs;
    }
    /** Remember the schedule a manual resume at `epoch` just took off the Goal. */
    retain(goalId, epoch, recoverAtMs) {
        this.retained.set(goalId, { epoch, recoverAtMs });
    }
    /** The retained reset time for a Turn of that attempt, if still ahead. */
    read(binding) {
        if (!binding)
            return undefined;
        const retained = this.retained.get(binding.goalId);
        if (!retained || retained.epoch !== binding.admittedGoalUpdatedAt)
            return undefined;
        return normalizeUsageRecoveryAtMs(retained.recoverAtMs, this.nowMs());
    }
    /**
     * Explicit user work (a queued ordinary message ahead of the resumed Goal
     * Turn) advances the epoch before the attempt runs. The attempt is still
     * the same one, so its schedule moves with it; any other epoch change
     * leaves the retained schedule behind.
     */
    carry(goalId, fromEpoch, toEpoch) {
        const retained = this.retained.get(goalId);
        if (retained?.epoch !== fromEpoch)
            return;
        this.retained.set(goalId, { epoch: toEpoch, recoverAtMs: retained.recoverAtMs });
    }
    forget(goalId) {
        this.retained.delete(goalId);
    }
}
//# sourceMappingURL=usage-recovery-retention.js.map