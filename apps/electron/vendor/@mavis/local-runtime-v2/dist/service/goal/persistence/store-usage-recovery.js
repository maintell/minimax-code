/**
 * Durable reads and the one guarded write behind automatic account-quota
 * recovery.
 *
 * The Goal row *is* the schedule. Keeping it there rather than in a separate
 * timer table is what makes the feature survive a restart with no bookkeeping:
 * whatever the process was tracking in memory is reconstructed by reading the
 * same rows again, and a recovery time that elapsed while the process was down
 * simply reads as overdue.
 */
import { THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON } from '@mavis/goal';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { localRuntimeV2Goals as goals } from '../../../infra/db/schema/goal.js';
import { readGoalRow, rowsToThreadGoalStates } from './store-row.js';
/**
 * Every Goal parked on an account quota that carries a recovery time.
 *
 * Read once at startup to rebuild the in-memory timers and to compensate for
 * any recovery time that passed while this process was not running. The query
 * mirrors the visibility predicate in `rowToThreadGoalState`, so a row it
 * returns is guaranteed to project a non-null `usageRecoveryAtMs`.
 */
export function listThreadGoalsAwaitingUsageRecovery(db) {
    return rowsToThreadGoalStates(db, db
        .select()
        .from(goals)
        .where(and(eq(goals.status, 'usage_limited'), eq(goals.statusReason, THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON), isNotNull(goals.usageRecoveryAtMs)))
        .orderBy(asc(goals.usageRecoveryAtMs), asc(goals.goalId))
        .all());
}
/**
 * Resume exactly the quota-stopped Goal this recovery was scheduled for.
 *
 * The write is guarded on the full identity of that stop — goal id, decision
 * epoch, status and status reason — and advances `updated_at_ms` so the resumed
 * Goal owns a fresh admission epoch, matching what a manual resume does. The
 * breaker counters are cleared for the same reason they are on a manual resume:
 * the Goal is continuing deliberately, not repeating a failed step.
 */
export function resumeThreadGoalAfterUsageRecovery(db, nowMs, input) {
    const current = readGoalRow(db, eq(goals.goalId, input.goalId));
    if (!current ||
        current.updatedAt !== input.expectedUpdatedAt ||
        current.status !== 'usage_limited' ||
        current.statusReason !== THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON ||
        current.usageRecoveryAtMs === null) {
        return { status: 'stale' };
    }
    const now = nowMs();
    if (current.usageRecoveryAtMs > now) {
        return { status: 'early', recoverAtMs: current.usageRecoveryAtMs };
    }
    const decisionEpoch = Math.max(now, current.updatedAt + 1);
    const result = db
        .update(goals)
        .set({
        status: 'active',
        statusReason: null,
        updatedAtMs: decisionEpoch,
        usageRecoveryAtMs: null,
        replyFingerprint: null,
        noProgressStreak: 0,
        noToolStreak: 0,
    })
        .where(and(eq(goals.goalId, input.goalId), eq(goals.updatedAtMs, input.expectedUpdatedAt), eq(goals.status, 'usage_limited')))
        .run();
    if (result.changes === 0)
        return { status: 'stale' };
    return {
        status: 'resumed',
        goal: {
            ...current,
            status: 'active',
            statusReason: null,
            updatedAt: decisionEpoch,
            usageRecoveryAtMs: null,
            replyFingerprint: null,
            noProgressStreak: 0,
            noToolStreak: 0,
            executionWait: null,
        },
    };
}
//# sourceMappingURL=store-usage-recovery.js.map