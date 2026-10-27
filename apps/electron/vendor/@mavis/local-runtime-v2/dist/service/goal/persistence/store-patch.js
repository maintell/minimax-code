import { THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON, ThreadGoalBudgetLimitedError, ThreadGoalEpochConflictError, ThreadGoalObjectiveConflictError, ThreadGoalStatusConflictError, ThreadGoalTokenBudgetExhaustedError, } from '@mavis/goal';
import { and, eq, ne } from 'drizzle-orm';
import { localRuntimeV2Goals as goals } from '../../../infra/db/schema/goal.js';
import { isKnownThreadGoalStatus, positiveOrNull, readRawGoalRow, rowToThreadGoalState, withGoalAccounting, } from './store-row.js';
/** Apply a user-authored Goal mutation and advance the admission epoch. */
export function patchThreadGoal(db, nowMs, goalId, input) {
    const existing = readRawGoalRow(db, eq(goals.goalId, goalId));
    const state = rowToThreadGoalState(existing);
    if (!state) {
        throw new Error(`Thread goal not found: ${goalId}`);
    }
    assertPatchGuards(state, input);
    const resumesTokenLimited = assertStatusTransition(state, existing?.status, input);
    // `updated_at_ms` is also the Goal decision epoch. A user-authored
    // mutation must invalidate an in-flight settlement even when both
    // writes happen inside the same wall-clock millisecond.
    const now = Math.max(nowMs(), state.updatedAt + 1);
    const next = planPatchedFields(state, input, resumesTokenLimited);
    const result = db
        .update(goals)
        .set({
        status: next.status,
        objective: next.objective,
        tokenBudget: next.tokenBudget,
        replyFingerprint: next.replyFingerprint,
        noProgressStreak: next.noProgressStreak,
        noToolStreak: next.noToolStreak,
        lastVerification: jsonOrNull(next.lastVerification),
        lastWorkerProposal: jsonOrNull(next.lastWorkerProposal),
        usageRecoveryAtMs: next.usageRecoveryAtMs,
        statusReason: next.statusReason,
        updatedAtMs: now,
        objectiveResourcesJson: JSON.stringify(next.objectiveResources ?? []),
    })
        .where(and(...patchGuards(goalId, input)))
        .run();
    if (isGuardedPatch(input) && result.changes === 0) {
        throw explainGuardedPatchMiss(db, goalId, input);
    }
    return withGoalAccounting(db, {
        ...state,
        ...next,
        updatedAt: now,
        executionWait: null,
    });
}
/** Caller-supplied optimistic guards, checked against the row just read. */
function assertPatchGuards(state, input) {
    if (state.status === input.rejectIfCurrentStatus) {
        throw new ThreadGoalStatusConflictError(state.goalId, state.status);
    }
    if (input.rejectIfObjectiveChangedFrom !== undefined &&
        state.objective !== input.rejectIfObjectiveChangedFrom) {
        throw new ThreadGoalObjectiveConflictError(state.goalId, input.rejectIfObjectiveChangedFrom, state.objective);
    }
    if (input.rejectIfUpdatedAtChangedFrom !== undefined &&
        state.updatedAt !== input.rejectIfUpdatedAtChangedFrom) {
        throw new ThreadGoalEpochConflictError(state.goalId, input.rejectIfUpdatedAtChangedFrom, state.updatedAt);
    }
    if (typeof input.tokenBudget === 'number' && input.tokenBudget <= state.tokensUsed) {
        throw new ThreadGoalTokenBudgetExhaustedError(state.goalId, state.tokensUsed, input.tokenBudget);
    }
}
/**
 * Refuse transitions the patch surface never allows and report whether this
 * patch reopens a token-limited Goal by raising or clearing its budget.
 */
function assertStatusTransition(state, persistedStatus, input) {
    if (input.status !== 'active')
        return false;
    const resumesTokenLimited = reopensTokenLimitedGoal(state, input);
    if (state.status === 'budget_limited' && !resumesTokenLimited) {
        throw new ThreadGoalBudgetLimitedError(state.goalId);
    }
    if (!isKnownThreadGoalStatus(persistedStatus)) {
        throw new ThreadGoalStatusConflictError(state.goalId, 'paused');
    }
    if (state.status === 'complete') {
        throw new ThreadGoalStatusConflictError(state.goalId, state.status);
    }
    return resumesTokenLimited;
}
function reopensTokenLimitedGoal(state, input) {
    return (state.status === 'budget_limited' &&
        state.statusReason === 'budget_limited(token)' &&
        input.tokenBudget !== undefined &&
        (input.tokenBudget === null || input.tokenBudget > state.tokensUsed));
}
function planPatchedFields(state, input, resumesTokenLimited) {
    const objective = planObjective(state, input);
    const resumed = input.status === 'active' && (isResumableStop(state) || resumesTokenLimited);
    const status = input.status ?? state.status;
    const statusReason = nextStatusReason(state, input);
    return {
        status,
        objective: objective.objective,
        objectiveResources: objective.objectiveResources,
        tokenBudget: nextTokenBudget(state, input),
        ...breakerFields(state, objective.changed || resumed),
        // A new objective invalidates what was learned about the old one.
        lastVerification: objective.changed ? undefined : state.lastVerification,
        lastWorkerProposal: objective.changed ? undefined : state.lastWorkerProposal,
        statusReason,
        usageRecoveryAtMs: keptUsageRecoveryAtMs(state, status, statusReason),
    };
}
function planObjective(state, input) {
    const objectiveResources = input.objectiveResources ?? state.objectiveResources ?? [];
    const changed = (input.objective !== undefined && input.objective !== state.objective) ||
        JSON.stringify(objectiveResources) !== JSON.stringify(state.objectiveResources ?? []);
    return { objective: input.objective ?? state.objective, objectiveResources, changed };
}
/**
 * `tokenBudget === undefined` means "don't touch"; an explicit `null` clears
 * the cap; a positive integer sets it. Anything else collapses to `null` via
 * `positiveOrNull`.
 */
function nextTokenBudget(state, input) {
    return input.tokenBudget === undefined ? state.tokenBudget : positiveOrNull(input.tokenBudget);
}
/**
 * The no-tool streak is a separate column with its own explicit clear list:
 * advancing the epoch alone must never be read as "the user re-armed this
 * counter", so every user-authored reset writes it by name.
 */
function breakerFields(state, reset) {
    return reset
        ? { replyFingerprint: null, noProgressStreak: 0, noToolStreak: 0 }
        : {
            replyFingerprint: state.replyFingerprint,
            noProgressStreak: state.noProgressStreak,
            noToolStreak: state.noToolStreak,
        };
}
/**
 * A user mutation keeps the account-quota schedule only while it leaves the
 * Goal parked on that same quota — editing the objective of a quota-stopped
 * Goal should still continue automatically once the quota returns. Resuming,
 * pausing or any other status change retires the schedule, so no timer can
 * outlive the stop it was created for.
 */
function keptUsageRecoveryAtMs(state, status, statusReason) {
    return status === 'usage_limited' && statusReason === THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON
        ? state.usageRecoveryAtMs
        : null;
}
function isResumableStop(state) {
    return (state.status === 'paused' || state.status === 'blocked' || state.status === 'usage_limited');
}
function nextStatusReason(state, input) {
    if (input.statusReason !== undefined)
        return input.statusReason;
    if (input.status !== undefined && input.status !== state.status)
        return null;
    return state.statusReason;
}
function patchGuards(goalId, input) {
    const guards = [eq(goals.goalId, goalId)];
    if (input.rejectIfCurrentStatus)
        guards.push(ne(goals.status, input.rejectIfCurrentStatus));
    if (input.rejectIfObjectiveChangedFrom !== undefined) {
        guards.push(eq(goals.objective, input.rejectIfObjectiveChangedFrom));
    }
    if (input.rejectIfUpdatedAtChangedFrom !== undefined) {
        guards.push(eq(goals.updatedAtMs, input.rejectIfUpdatedAtChangedFrom));
    }
    return guards;
}
function isGuardedPatch(input) {
    return (Boolean(input.rejectIfCurrentStatus) ||
        input.rejectIfObjectiveChangedFrom !== undefined ||
        input.rejectIfUpdatedAtChangedFrom !== undefined);
}
/** A guarded write changed nothing: name the guard a concurrent writer broke. */
function explainGuardedPatchMiss(db, goalId, input) {
    const current = rowToThreadGoalState(readRawGoalRow(db, eq(goals.goalId, goalId)));
    if (!current)
        return new Error(`Thread goal not found: ${goalId}`);
    const rejectStatus = input.rejectIfCurrentStatus;
    if (rejectStatus && current.status === rejectStatus) {
        return new ThreadGoalStatusConflictError(goalId, current.status);
    }
    const expectedObjective = input.rejectIfObjectiveChangedFrom;
    if (expectedObjective !== undefined && current.objective !== expectedObjective) {
        return new ThreadGoalObjectiveConflictError(goalId, expectedObjective, current.objective);
    }
    const expectedUpdatedAt = input.rejectIfUpdatedAtChangedFrom;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
        return new ThreadGoalEpochConflictError(goalId, expectedUpdatedAt, current.updatedAt);
    }
    return new Error(`Thread goal guarded patch made no change: ${goalId}`);
}
function jsonOrNull(value) {
    return value === undefined ? null : JSON.stringify(value);
}
//# sourceMappingURL=store-patch.js.map