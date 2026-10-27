/**
 * Drizzle-backed Goal store owned by local-runtime-v2.
 *
 * The table is `local_runtime_v2_goals` (migration 46). `session_id` is unique,
 * so each Session has at most one Goal row at any time. `updated_at_ms` is the
 * Goal decision epoch: every compare-and-set write below guards on it, and
 * only writers that take over the Goal's next step advance it.
 *
 * Timestamps are Unix ms (project rule — no ISO strings in storage / API).
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { ThreadGoalAlreadyExistsError, } from '@mavis/goal';
import { FULL_USAGE_TOKEN_ACCOUNTING, localRuntimeV2Goals as goals, } from '../../../infra/db/schema/goal.js';
import { runWithWriteLock } from '../../../infra/db/write-transaction.js';
import { updateThreadGoalBreaker } from './store-breaker.js';
import { bumpThreadGoalBoundUsage, settleThreadGoalBoundTurn } from './store-bound-settlement.js';
import { clearThreadGoalExecutionWait, listThreadGoalsWaitingOnVerification, setThreadGoalExecutionWait, } from './store-execution.js';
import { patchThreadGoal } from './store-patch.js';
import { listThreadGoalsAwaitingUsageRecovery, resumeThreadGoalAfterUsageRecovery, } from './store-usage-recovery.js';
import { recordThreadGoalVerification } from './store-verification.js';
import { markGoalRequestDispatching, recordGoalRequestAttempts, recoverInterruptedGoalRequests, reserveGoalRequest, settleGoalRequest, } from '../accounting/request-ledger.js';
import { countTurnGraceRequests } from '../accounting/request-projection.js';
import { chargeGoalTokenRequest, recoverInterruptedGoalTokenCharges, } from '../accounting/token-charges.js';
import { newThreadGoalId, positiveOrNull, readGoalRow, rowsToThreadGoalStates, withGoalAccounting, } from './store-row.js';
/** The dismissed Goal is not this Session's current completed Goal. */
class ThreadGoalDismissConflictError extends Error {
    statusCode = 409;
    code = 'GOAL_DISMISS_CONFLICT';
    constructor(sessionId, goalId) {
        super(`Goal ${goalId} is not the current completed Goal for session ${sessionId}`);
        this.name = 'ThreadGoalDismissConflictError';
    }
}
export class DrizzleGoalStore {
    db;
    nowMs;
    genId;
    constructor(db, nowMs = () => Date.now(), genId = newThreadGoalId) {
        this.db = db;
        this.nowMs = nowMs;
        this.genId = genId;
    }
    async getBySession(sessionId) {
        return readGoalRow(this.db, eq(goals.sessionId, sessionId));
    }
    async getById(goalId) {
        return readGoalRow(this.db, eq(goals.goalId, goalId));
    }
    /**
     * Synchronous check for a questionnaire write that must see the Goal inside
     * its own transaction: true while the Session's Goal is this Goal and active.
     */
    isActiveGoal(sessionId, goalId) {
        const goal = readGoalRow(this.db, eq(goals.sessionId, sessionId));
        return goal?.goalId === goalId && goal.status === 'active';
    }
    /**
     * Atomically pause the session's goal only while it is still active.
     * Used by the explicit session-abort path so a concurrent model update
     * cannot reopen or overwrite an already-terminal goal.
     */
    async pauseActiveBySession(sessionId, statusReason = 'paused(user_requested)') {
        return this.write((tx) => {
            const result = tx
                .update(goals)
                .set({
                status: 'paused',
                statusReason,
                updatedAtMs: sql `MAX(${this.nowMs()}, ${goals.updatedAtMs} + 1)`,
            })
                .where(and(eq(goals.sessionId, sessionId), eq(goals.status, 'active')))
                .run();
            if (result.changes === 0)
                return undefined;
            return readGoalRow(tx, eq(goals.sessionId, sessionId));
        });
    }
    /**
     * The user's explicit pause (spec §9: a pause carries no version and always
     * takes effect). Besides an `active` Goal it also pauses one waiting on the
     * account quota, and drops that Goal's automatic-recovery schedule: a Goal
     * paused while it waits does not resume on its own (spec §7). `complete`,
     * `blocked`, `budget_limited` and an already `paused` Goal are left as they
     * are. The stop cascade of an ordinary Turn keeps using
     * `pauseActiveBySession`, which never touches a quota-limited Goal.
     */
    async pauseByUser(sessionId, statusReason = 'paused(user_requested)') {
        return this.write((tx) => {
            const result = tx
                .update(goals)
                .set({
                status: 'paused',
                statusReason,
                usageRecoveryAtMs: null,
                updatedAtMs: sql `MAX(${this.nowMs()}, ${goals.updatedAtMs} + 1)`,
            })
                .where(and(eq(goals.sessionId, sessionId), inArray(goals.status, ['active', 'usage_limited'])))
                .run();
            if (result.changes === 0)
                return undefined;
            return readGoalRow(tx, eq(goals.sessionId, sessionId));
        });
    }
    /** Apply a final-admission typed stop only to the exact active Goal epoch. */
    async transitionActiveAtEpoch(goalId, expectedEpoch, input) {
        return this.write((tx) => {
            const nextEpoch = Math.max(this.nowMs(), expectedEpoch + 1);
            const result = tx
                .update(goals)
                .set({ status: input.status, statusReason: input.statusReason, updatedAtMs: nextEpoch })
                .where(activeAtEpoch(goalId, expectedEpoch))
                .run();
            if (result.changes === 0)
                return undefined;
            return readGoalRow(tx, eq(goals.goalId, goalId));
        });
    }
    /** Explicit user work resets breaker state and invalidates older bindings. */
    async resetBreakerAtEpoch(goalId, expectedEpoch) {
        return this.write((tx) => {
            const nextEpoch = Math.max(this.nowMs(), expectedEpoch + 1);
            const result = tx
                .update(goals)
                .set({
                replyFingerprint: null,
                noProgressStreak: 0,
                noToolStreak: 0,
                updatedAtMs: nextEpoch,
            })
                .where(activeAtEpoch(goalId, expectedEpoch))
                .run();
            if (result.changes === 0)
                return undefined;
            return readGoalRow(tx, eq(goals.goalId, goalId));
        });
    }
    async create(input) {
        return this.write((tx) => {
            // codex parity (`insert_thread_goal`'s `ON CONFLICT … WHERE
            // status = 'complete'`): silently replace ONLY a complete goal.
            // active / paused / blocked / budget_limited all count as
            // unfinished — the model (or user) must finish or clear them
            // before starting a new one.
            const existing = tx
                .select({ goalId: goals.goalId, status: goals.status })
                .from(goals)
                .where(eq(goals.sessionId, input.sessionId))
                .get();
            if (existing && existing.status !== 'complete') {
                throw new ThreadGoalAlreadyExistsError(existing.goalId);
            }
            if (existing) {
                // Complete goal — the model has signed off on it already, so a
                // new objective is semantically a fresh start. Replace it.
                tx.delete(goals).where(eq(goals.sessionId, input.sessionId)).run();
            }
            const now = this.nowMs();
            const goalId = this.genId();
            const tokenBudget = positiveOrNull(input.tokenBudget ?? null);
            const kickoffAttachments = (input.kickoffAttachments ?? []).map((attachment) => ({
                ...attachment,
            }));
            tx.insert(goals)
                .values({
                goalId,
                sessionId: input.sessionId,
                objective: input.objective,
                status: 'active',
                createdAtMs: now,
                updatedAtMs: now,
                tokenBudget,
                kickoffAttachmentsJson: JSON.stringify(kickoffAttachments),
                kickoffState: 'pending',
                objectiveResourcesJson: JSON.stringify(input.objectiveResources ?? []),
                tokenAccountingVersion: FULL_USAGE_TOKEN_ACCOUNTING,
            })
                .run();
            return withGoalAccounting(tx, {
                goalId,
                sessionId: input.sessionId,
                objective: input.objective,
                objectiveResources: input.objectiveResources ?? [],
                status: 'active',
                createdAt: now,
                updatedAt: now,
                tokensUsed: 0,
                tokenUsage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
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
                usageRecoveryAtMs: null,
            });
        });
    }
    async patch(goalId, input) {
        return this.write((tx) => patchThreadGoal(tx, this.nowMs, goalId, input));
    }
    /** User-authored Goal mutations; kept distinct from host settlement CAS. */
    async patchByUser(goalId, input) {
        return this.patch(goalId, input);
    }
    /**
     * Hide the completion notice of this Session's completed Goal. Idempotent and
     * display-only: it never advances the admission epoch.
     */
    async dismissCompleted(sessionId, goalId) {
        return this.write((tx) => {
            const where = and(eq(goals.sessionId, sessionId), eq(goals.goalId, goalId));
            const result = tx
                .update(goals)
                .set({ dismissedAtMs: sql `COALESCE(${goals.dismissedAtMs}, ${this.nowMs()})` })
                .where(and(where, eq(goals.status, 'complete')))
                .run();
            const dismissed = result.changes === 0 ? undefined : readGoalRow(tx, where);
            if (!dismissed)
                throw new ThreadGoalDismissConflictError(sessionId, goalId);
            return dismissed;
        });
    }
    async bumpBoundUsage(binding, delta, limits) {
        return this.write((tx) => bumpThreadGoalBoundUsage(tx, this.nowMs, { binding, delta, limits }));
    }
    async settleBoundTurn(input) {
        return this.write((tx) => settleThreadGoalBoundTurn(tx, this.nowMs, input));
    }
    async updateBreaker(goalId, input) {
        return this.write((tx) => updateThreadGoalBreaker(tx, this.nowMs, goalId, input));
    }
    async recordVerification(input) {
        return this.write((tx) => recordThreadGoalVerification(tx, this.nowMs, input));
    }
    async delete(goalId) {
        await this.write((tx) => {
            tx.delete(goals).where(eq(goals.goalId, goalId)).run();
        });
    }
    async listRecoverableKickoffs() {
        return rowsToThreadGoalStates(this.db, this.db
            .select()
            .from(goals)
            .where(and(inArray(goals.kickoffState, ['pending', 'enqueued']), ne(goals.status, 'complete')))
            .orderBy(asc(goals.createdAtMs), asc(goals.goalId))
            .all());
    }
    /** Budget-limited Goals; startup uses them to retire pre-upgrade budget-summary items. */
    async listBudgetLimitedGoals() {
        return rowsToThreadGoalStates(this.db, this.db
            .select()
            .from(goals)
            .where(eq(goals.status, 'budget_limited'))
            .orderBy(asc(goals.updatedAtMs), asc(goals.goalId))
            .all());
    }
    async listRecoverableActiveGoals() {
        return rowsToThreadGoalStates(this.db, this.db
            .select()
            .from(goals)
            .where(and(eq(goals.kickoffState, 'consumed'), eq(goals.status, 'active')))
            .orderBy(asc(goals.updatedAtMs), asc(goals.goalId))
            .all());
    }
    async transitionKickoffState(goalId, expected, next) {
        return this.write((tx) => {
            const result = tx
                .update(goals)
                .set({ kickoffState: next })
                .where(and(eq(goals.goalId, goalId), eq(goals.kickoffState, expected)))
                .run();
            if (result.changes === 0)
                return undefined;
            return readGoalRow(tx, eq(goals.goalId, goalId));
        });
    }
    async setExecutionWaitAtEpoch(input) {
        return this.write((tx) => setThreadGoalExecutionWait(tx, { ...input, nowMs: this.nowMs() }));
    }
    async clearExecutionWaitAtEpoch(input) {
        return this.write((tx) => clearThreadGoalExecutionWait(tx, input));
    }
    /** Goals still showing `verification` — only ever stale rows at startup. */
    async listGoalsWaitingOnVerification() {
        return listThreadGoalsWaitingOnVerification(this.db);
    }
    /** Goals parked on an account quota that carries a durable recovery time. */
    async listGoalsAwaitingUsageRecovery() {
        return listThreadGoalsAwaitingUsageRecovery(this.db);
    }
    /** Resume exactly the quota stop identified by `expectedUpdatedAt`. */
    async resumeAfterUsageRecoveryAtEpoch(input) {
        return this.write((tx) => resumeThreadGoalAfterUsageRecovery(tx, this.nowMs, input));
    }
    /** Reserve one Goal main-execution request before it is sent. */
    async reserveRequest(input) {
        return this.write((tx) => reserveGoalRequest(tx, this.nowMs(), input));
    }
    async markRequestDispatching(input) {
        await this.write((tx) => markGoalRequestDispatching(tx, this.nowMs(), input));
    }
    /** Record an open request's attempt usage so far, charging the Goal only its growth. */
    async recordRequestAttempts(input) {
        return this.write((tx) => recordGoalRequestAttempts(tx, this.nowMs(), input));
    }
    /** Settle one request and charge its known usage to the Goal it was admitted for. */
    async settleRequest(input) {
        return this.write((tx) => settleGoalRequest(tx, this.nowMs(), input));
    }
    /**
     * Release never-sent reservations, settle requests whose every attempt has a
     * receipt, and keep possibly in-flight requests as unknown. Token charges
     * left open keep what they charged and are marked unresolved.
     */
    async recoverInterruptedRequests() {
        return this.write((tx) => {
            recoverInterruptedGoalTokenCharges(tx, this.nowMs());
            return recoverInterruptedGoalRequests(tx, this.nowMs());
        });
    }
    /** Charge a full-usage Goal one request outside the ledger, only its growth. */
    async chargeTokens(input) {
        return this.write((tx) => chargeGoalTokenRequest(tx, this.nowMs(), input));
    }
    countTurnGraceRequests(turnId) {
        return countTurnGraceRequests(this.db, turnId);
    }
    write(mutation) {
        return runWithWriteLock(this.db, mutation);
    }
}
function activeAtEpoch(goalId, expectedEpoch) {
    return and(eq(goals.goalId, goalId), eq(goals.updatedAtMs, expectedEpoch), eq(goals.status, 'active'));
}
//# sourceMappingURL=store.js.map