/**
 * SQLite-backed `ThreadGoalStore` implementation for local-runtime.
 *
 * Schema lives in `persistence/db.ts` migration v13 (table
 * `local_runtime_thread_goals`). `session_id` carries a UNIQUE index so
 * each session has at most one goal row at any time, matching codex's
 * `thread_goals.thread_id PRIMARY KEY` semantics.
 *
 * Timestamps are stored as Unix ms (project rule — no ISO strings in
 * storage / API).
 */
import { ThreadGoalAlreadyExistsError, } from '@mavis/goal';
import { runInImmediateTransaction, withLocalRuntimeDb, } from '../persistence/db.js';
import { updateThreadGoalBreaker } from './store-breaker.js';
import { bumpThreadGoalBoundUsage, settleThreadGoalBoundTurn } from './store-bound-settlement.js';
import { clearThreadGoalExecutionWait, listThreadGoalsWaitingOnVerification, setThreadGoalExecutionWait, } from './store-execution.js';
import { patchThreadGoal } from './store-patch.js';
import { recordThreadGoalVerification } from './store-verification.js';
import { newThreadGoalId, positiveOrNull, rowToThreadGoalState, } from './store-row.js';
export class ThreadGoalDismissConflictError extends Error {
    statusCode = 409;
    code = 'GOAL_DISMISS_CONFLICT';
    constructor(sessionId, goalId) {
        super(`Goal ${goalId} is not the current completed Goal for session ${sessionId}`);
        this.name = 'ThreadGoalDismissConflictError';
    }
}
export class SqliteThreadGoalStore {
    dataDir;
    nowMs;
    genId;
    constructor(dataDir, nowMs = () => Date.now(), genId = newThreadGoalId) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
        this.genId = genId;
    }
    async getBySession(sessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE session_id = ?`)
                .get(sessionId);
            return rowToThreadGoalState(row);
        });
    }
    async getById(goalId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
                .get(goalId);
            return rowToThreadGoalState(row);
        });
    }
    /**
     * Atomically pause the session's goal only while it is still active.
     * Used by the explicit session-abort path so a concurrent model update
     * cannot reopen or overwrite an already-terminal goal.
     */
    async pauseActiveBySession(sessionId, statusReason = 'paused(user_requested)') {
        return this.withDb((db) => {
            const now = this.nowMs();
            const result = db
                .prepare(`UPDATE local_runtime_thread_goals
           SET status = 'paused', status_reason = ?,
               updated_at_ms = MAX(?, updated_at_ms + 1)
           WHERE session_id = ? AND status = 'active'`)
                .run(statusReason, now, sessionId);
            if ((result.changes ?? 0) === 0)
                return undefined;
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE session_id = ?`)
                .get(sessionId);
            return rowToThreadGoalState(row);
        });
    }
    /** Apply a final-admission typed stop only to the exact active Goal epoch. */
    async transitionActiveAtEpoch(goalId, expectedEpoch, input) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            const nextEpoch = Math.max(this.nowMs(), expectedEpoch + 1);
            const result = db
                .prepare(`UPDATE local_runtime_thread_goals
             SET status = ?, status_reason = ?, updated_at_ms = ?
             WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`)
                .run(input.status, input.statusReason, nextEpoch, goalId, expectedEpoch);
            if ((result.changes ?? 0) === 0)
                return undefined;
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
                .get(goalId);
            return rowToThreadGoalState(row);
        }));
    }
    /** Explicit user work resets breaker state and invalidates older bindings. */
    async resetBreakerAtEpoch(goalId, expectedEpoch) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            const nextEpoch = Math.max(this.nowMs(), expectedEpoch + 1);
            const result = db
                .prepare(`UPDATE local_runtime_thread_goals
             SET reply_fingerprint = NULL, no_progress_streak = 0, no_tool_streak = 0,
                 updated_at_ms = ?
             WHERE goal_id = ? AND updated_at_ms = ? AND status = 'active'`)
                .run(nextEpoch, goalId, expectedEpoch);
            if ((result.changes ?? 0) === 0)
                return undefined;
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
                .get(goalId);
            return rowToThreadGoalState(row);
        }));
    }
    async create(input) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            // codex parity (`insert_thread_goal`'s `ON CONFLICT … WHERE
            // status = 'complete'`): silently replace ONLY a complete goal.
            // active / paused / blocked / budget_limited all count as
            // unfinished — the model (or user) must finish or clear them
            // before starting a new one.
            const existing = db
                .prepare(`SELECT goal_id, status FROM local_runtime_thread_goals WHERE session_id = ?`)
                .get(input.sessionId);
            if (existing && existing.status !== 'complete') {
                throw new ThreadGoalAlreadyExistsError(existing.goal_id ?? '');
            }
            if (existing) {
                // Complete goal — the model has signed off on it already, so a
                // new objective is semantically a fresh start. Replace it.
                db.prepare(`DELETE FROM local_runtime_thread_goals WHERE session_id = ?`).run(input.sessionId);
            }
            const now = this.nowMs();
            const goalId = this.genId();
            const tokenBudget = positiveOrNull(input.tokenBudget ?? null);
            const kickoffAttachments = (input.kickoffAttachments ?? []).map((attachment) => ({
                ...attachment,
            }));
            db.prepare(`INSERT INTO local_runtime_thread_goals
         (
           goal_id, session_id, objective, status, created_at_ms, updated_at_ms,
           token_budget, kickoff_attachments_json, kickoff_state, objective_resources_json
         )
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, 'pending', ?)`).run(goalId, input.sessionId, input.objective, now, now, tokenBudget, JSON.stringify(kickoffAttachments), JSON.stringify(input.objectiveResources ?? []));
            return {
                goalId,
                sessionId: input.sessionId,
                objective: input.objective,
                objectiveResources: input.objectiveResources ?? [],
                status: 'active',
                createdAt: now,
                updatedAt: now,
                tokensUsed: 0,
                turnsUsed: 0,
                timeUsedSeconds: 0,
                tokenBudget,
                replyFingerprint: null,
                noProgressStreak: 0,
                noToolStreak: 0,
                lastVerification: undefined,
                statusReason: null,
                kickoffAttachments,
                kickoffState: 'pending',
                executionWait: null,
            };
        }));
    }
    async patch(goalId, input) {
        return this.withDb((db) => patchThreadGoal(db, this.nowMs, goalId, input));
    }
    /** User-authored Goal mutations; kept distinct from host settlement CAS. */
    async patchByUser(goalId, input) {
        return this.patch(goalId, input);
    }
    /** 仅隐藏指定已完成 Goal 的提示；幂等写入，不推进执行 epoch。 */
    async dismissCompleted(sessionId, goalId) {
        return this.withDb((db) => runInImmediateTransaction(db, () => {
            const result = db
                .prepare(`UPDATE local_runtime_thread_goals
             SET dismissed_at_ms = COALESCE(dismissed_at_ms, ?)
             WHERE session_id = ? AND goal_id = ? AND status = 'complete'`)
                .run(this.nowMs(), sessionId, goalId);
            if ((result.changes ?? 0) === 0) {
                throw new ThreadGoalDismissConflictError(sessionId, goalId);
            }
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE session_id = ? AND goal_id = ?`)
                .get(sessionId, goalId);
            const goal = rowToThreadGoalState(row);
            if (!goal)
                throw new ThreadGoalDismissConflictError(sessionId, goalId);
            return goal;
        }));
    }
    async bumpBoundUsage(binding, delta, limits) {
        return this.withDb((db) => bumpThreadGoalBoundUsage(db, this.nowMs, binding, delta, limits));
    }
    async settleBoundTurn(input) {
        return this.withDb((db) => settleThreadGoalBoundTurn(db, this.nowMs, input));
    }
    async updateBreaker(goalId, input) {
        return this.withDb((db) => updateThreadGoalBreaker(db, this.nowMs, goalId, input));
    }
    async recordVerification(input) {
        return this.withDb((db) => recordThreadGoalVerification(db, this.nowMs, input));
    }
    async delete(goalId) {
        this.withDb((db) => {
            db.prepare(`DELETE FROM local_runtime_thread_goals WHERE goal_id = ?`).run(goalId);
        });
    }
    async listRecoverableKickoffs() {
        return this.withDb((db) => db
            .prepare(`SELECT * FROM local_runtime_thread_goals
           WHERE kickoff_state IN ('pending', 'enqueued')
             AND status <> 'complete'
           ORDER BY created_at_ms, goal_id`)
            .all()
            .flatMap((row) => {
            const state = rowToThreadGoalState(row);
            return state ? [state] : [];
        }));
    }
    async listRecoverableActiveGoals() {
        return this.withDb((db) => db
            .prepare(`SELECT * FROM local_runtime_thread_goals
           WHERE kickoff_state = 'consumed'
             AND status = 'active'
           ORDER BY updated_at_ms, goal_id`)
            .all()
            .flatMap((row) => {
            const state = rowToThreadGoalState(row);
            return state ? [state] : [];
        }));
    }
    /** Budget summaries are replayed with an epoch-derived idempotency key. */
    async listRecoverableBudgetLimitSummaries() {
        return this.withDb((db) => db
            .prepare(`SELECT * FROM local_runtime_thread_goals
           WHERE status = 'budget_limited'
           ORDER BY updated_at_ms, goal_id`)
            .all()
            .flatMap((row) => {
            const state = rowToThreadGoalState(row);
            return state ? [state] : [];
        }));
    }
    /** Only new, undelivered proposals are eligible; never wake historical completed Goals. */
    async listRecoverableCompletionSummaries() {
        return this.withDb((db) => db
            .prepare(`SELECT * FROM local_runtime_thread_goals WHERE status = 'complete'
        ORDER BY updated_at_ms, goal_id`)
            .all()
            .flatMap((row) => {
            const state = rowToThreadGoalState(row);
            return state?.lastWorkerProposal?.type === 'complete' &&
                state.lastWorkerProposal.resultDelivery === 'pending'
                ? [state]
                : [];
        }));
    }
    /** Delivery receipt is not a new Goal decision and must not advance its admission epoch. */
    async markCompletionSummaryQueued(goalId, proposalTurnId) {
        this.withDb((db) => {
            db.prepare(`UPDATE local_runtime_thread_goals
        SET last_worker_proposal = json_set(last_worker_proposal, '$.resultDelivery', 'queued')
        WHERE goal_id = ? AND status = 'complete'
          AND json_valid(last_worker_proposal)
          AND json_extract(last_worker_proposal, '$.type') = 'complete'
          AND json_extract(last_worker_proposal, '$.turnId') = ?
          AND json_extract(last_worker_proposal, '$.resultDelivery') = 'pending'`).run(goalId, proposalTurnId);
        });
    }
    async transitionKickoffState(goalId, expected, next) {
        return this.withDb((db) => {
            const result = db
                .prepare(`UPDATE local_runtime_thread_goals
           SET kickoff_state = ?
           WHERE goal_id = ? AND kickoff_state = ?`)
                .run(next, goalId, expected);
            if ((result.changes ?? 0) === 0)
                return undefined;
            const row = db
                .prepare(`SELECT * FROM local_runtime_thread_goals WHERE goal_id = ?`)
                .get(goalId);
            return rowToThreadGoalState(row);
        });
    }
    async setExecutionWaitAtEpoch(input) {
        return this.withDb((db) => setThreadGoalExecutionWait(db, { ...input, nowMs: this.nowMs() }));
    }
    async clearExecutionWaitAtEpoch(input) {
        return this.withDb((db) => clearThreadGoalExecutionWait(db, input));
    }
    /** Goals still showing `verification` — only ever stale rows at startup. */
    async listGoalsWaitingOnVerification() {
        return this.withDb((db) => listThreadGoalsWaitingOnVerification(db));
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
//# sourceMappingURL=store.js.map