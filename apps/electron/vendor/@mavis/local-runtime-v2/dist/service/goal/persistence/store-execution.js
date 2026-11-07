import {} from '@mavis/goal';
import { and, asc, eq } from 'drizzle-orm';
import { localRuntimeV2Goals as goals } from '../../../infra/db/schema/goal.js';
import { readRawGoalRow, rowToThreadGoalState, rowsToThreadGoalStates, withGoalAccounting, } from './store-row.js';
/**
 * Durable "why is this Goal not running" projection.
 *
 * Three rules make these writes safe to issue from admission, which runs on the
 * hot queue path:
 *
 *  - They never touch `updated_at_ms`. That column is the Turn admission
 *    decision epoch; advancing it merely to publish a wait would invalidate the
 *    very kickoff we are explaining.
 *  - They are guarded by that same epoch plus `status = 'active'`, so a
 *    decision computed against a Goal that has since moved on is dropped
 *    instead of resurrecting a stale reason.
 *  - They stamp the epoch they were decided against into
 *    `execution_wait_epoch`. `rowToThreadGoalState` only surfaces a wait whose
 *    epoch still matches `updated_at_ms`, so this module is the *only* place
 *    that has to know these columns exist: every other writer retires the wait
 *    simply by advancing the epoch, and a future one cannot forget to.
 *
 * Both helpers return `undefined` when nothing changed — including the common
 * case of re-observing the same blocker on every drain — so callers can skip
 * publishing a redundant update event and the UI's wait timer keeps counting
 * from the original `sinceMs`.
 */
export function setThreadGoalExecutionWait(db, input) {
    const current = readRow(db, input.goalId);
    if (!isCurrentActiveEpoch(current, input.expectedUpdatedAt))
        return undefined;
    // Only a wait already visible at *this* epoch is a no-op. A row carrying the
    // same reason under an older epoch is invisible to readers, so it must be
    // rewritten rather than deduplicated away.
    if (hasVisibleWait(current) && current.executionWaitReason === input.reason)
        return undefined;
    const result = db
        .update(goals)
        .set({
        executionWaitReason: input.reason,
        executionWaitSinceMs: input.nowMs,
        executionWaitEpoch: input.expectedUpdatedAt,
    })
        .where(activeAtEpoch(input.goalId, input.expectedUpdatedAt))
        .run();
    if (result.changes === 0)
        return undefined;
    return withGoalAccounting(db, rowToThreadGoalState(readRow(db, input.goalId)));
}
export function clearThreadGoalExecutionWait(db, input) {
    const current = readRow(db, input.goalId);
    if (!isCurrentActiveEpoch(current, input.expectedUpdatedAt))
        return undefined;
    // Nothing visible to clear: either no wait was written, or the one on the
    // row belongs to a superseded epoch and already reads as absent.
    if (!hasVisibleWait(current))
        return undefined;
    const result = db
        .update(goals)
        .set({ executionWaitReason: null, executionWaitSinceMs: null, executionWaitEpoch: null })
        .where(activeAtEpoch(input.goalId, input.expectedUpdatedAt))
        .run();
    if (result.changes === 0)
        return undefined;
    return withGoalAccounting(db, rowToThreadGoalState(readRow(db, input.goalId)));
}
/**
 * Every Goal whose *visible* wait is `verification`.
 *
 * Used once at startup. A verifier dispatch lives only in the process that
 * issued it, so any such wait that survived a restart is by construction
 * stale — there is no verifier left to clear it, and the epoch guard cannot
 * retire it either because a crash advances nothing. The query matches the
 * exact visibility predicate `rowToThreadGoalState` applies, and deliberately
 * does not filter on `kickoff_state`: startup cleanup must not inherit the
 * skip conditions of continuation recovery.
 */
export function listThreadGoalsWaitingOnVerification(db) {
    return rowsToThreadGoalStates(db, db
        .select()
        .from(goals)
        .where(and(eq(goals.status, 'active'), eq(goals.executionWaitReason, 'verification'), eq(goals.executionWaitEpoch, goals.updatedAtMs)))
        .orderBy(asc(goals.updatedAtMs), asc(goals.goalId))
        .all());
}
function isCurrentActiveEpoch(row, expectedUpdatedAt) {
    return !!row && row.status === 'active' && row.updatedAtMs === expectedUpdatedAt;
}
/** Mirrors the `rowToThreadGoalState` epoch guard for an already-current row. */
function hasVisibleWait(row) {
    return row.executionWaitReason != null && row.executionWaitEpoch === row.updatedAtMs;
}
function readRow(db, goalId) {
    return readRawGoalRow(db, eq(goals.goalId, goalId));
}
function activeAtEpoch(goalId, expectedUpdatedAt) {
    return and(eq(goals.goalId, goalId), eq(goals.updatedAtMs, expectedUpdatedAt), eq(goals.status, 'active'));
}
//# sourceMappingURL=store-execution.js.map