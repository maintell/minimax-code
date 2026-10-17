import { runInImmediateTransaction } from '../persistence/db.js';
import { rowToThreadGoalState } from './store-row.js';
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
    return runInImmediateTransaction(db, () => {
        const current = readRow(db, input.goalId);
        if (!isCurrentActiveEpoch(current, input.expectedUpdatedAt))
            return undefined;
        // Only a wait already visible at *this* epoch is a no-op. A row carrying the
        // same reason under an older epoch is invisible to readers, so it must be
        // rewritten rather than deduplicated away.
        if (hasVisibleWait(current) && current.execution_wait_reason === input.reason)
            return undefined;
        const result = db
            .prepare(`UPDATE local_runtime_thread_goals
         SET execution_wait_reason = ?, execution_wait_since_ms = ?, execution_wait_epoch = ?
         WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`)
            .run(input.reason, input.nowMs, input.expectedUpdatedAt, input.goalId, input.expectedUpdatedAt);
        if ((result.changes ?? 0) === 0)
            return undefined;
        return rowToThreadGoalState(readRow(db, input.goalId));
    });
}
export function clearThreadGoalExecutionWait(db, input) {
    return runInImmediateTransaction(db, () => {
        const current = readRow(db, input.goalId);
        if (!isCurrentActiveEpoch(current, input.expectedUpdatedAt))
            return undefined;
        // Nothing visible to clear: either no wait was written, or the one on the
        // row belongs to a superseded epoch and already reads as absent.
        if (!hasVisibleWait(current))
            return undefined;
        const result = db
            .prepare(`UPDATE local_runtime_thread_goals
         SET execution_wait_reason = NULL, execution_wait_since_ms = NULL,
             execution_wait_epoch = NULL
         WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`)
            .run(input.goalId, input.expectedUpdatedAt);
        if ((result.changes ?? 0) === 0)
            return undefined;
        return rowToThreadGoalState(readRow(db, input.goalId));
    });
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
    return db
        .prepare(`SELECT * FROM local_runtime_thread_goals
       WHERE status = 'active'
         AND execution_wait_reason = 'verification'
         AND execution_wait_epoch = updated_at_ms
       ORDER BY updated_at_ms, goal_id`)
        .all()
        .flatMap((row) => {
        const state = rowToThreadGoalState(row);
        return state ? [state] : [];
    });
}
function isCurrentActiveEpoch(row, expectedUpdatedAt) {
    return !!row && row.status === 'active' && row.updated_at_ms === expectedUpdatedAt;
}
/** Mirrors the `rowToThreadGoalState` epoch guard for an already-current row. */
function hasVisibleWait(row) {
    return row.execution_wait_reason != null && row.execution_wait_epoch === row.updated_at_ms;
}
function readRow(db, goalId) {
    return db.prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`).get(goalId);
}
//# sourceMappingURL=store-execution.js.map