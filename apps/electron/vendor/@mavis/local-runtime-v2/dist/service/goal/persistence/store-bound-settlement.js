import { THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON, } from '@mavis/goal';
import { and, eq } from 'drizzle-orm';
import { localRuntimeV2Goals as goals } from '../../../infra/db/schema/goal.js';
import { classifyThreadGoalAccountingStale, threadGoalStaleDecision } from './binding-stale.js';
import { numericOrZero, readGoalRow } from './store-row.js';
import { materializeThreadGoalWorkerProposal } from './store-worker-proposal.js';
/**
 * Attribute one admitted Turn and make any budget stop in the same short
 * transaction.
 *
 * Note the asymmetry with `settleThreadGoalBoundTurn` below: this operation
 * writes the usage **even when the binding is stale**, and reports the reason
 * alongside the write instead of refusing it. Consumption already happened —
 * the tokens were spent and the wall clock ran regardless of what the row now
 * says — so dropping the write would let a Goal spend real budget for free
 * every time an objective edit or a concurrent decision landed mid-Turn, which
 * is the one failure the three-dimension budget exists to prevent. Decisions
 * are still refused: a stale charge makes no budget stop, and
 * `settlementStage2ClassifyStale` reads `staleReason` off this result and
 * hard-stops before any decision is derived from it.
 *
 * The same asymmetry applies to `updated_at_ms`. Consumption is a fact about
 * the Goal; the decision epoch is the token for who owns its next step. A
 * charge only advances the epoch when it actually makes a decision — a budget
 * crossing — so a stale charge records the spend and leaves the Goal's current
 * runner alone.
 */
export function bumpThreadGoalBoundUsage(db, nowMs, input) {
    const { binding, limits } = input;
    const state = readGoal(db, binding.goalId);
    if (!state)
        return { staleReason: 'missing_goal' };
    const staleReason = classifyThreadGoalAccountingStale(state, {
        expectedEpoch: binding.admittedGoalUpdatedAt,
        objectiveDigest: binding.objectiveDigest,
    });
    const delta = normalizeUsageDelta(input.delta);
    const totals = chargedTotals(state, delta);
    // Tokens are charged per request before the Turn settles, so a Turn that
    // adds nothing here may still have crossed the token budget: decide it.
    // A stale charge only records the spend (spec §4.5: late usage cannot change
    // the current Goal's state); the limits it carries may predate a budget edit,
    // and the current runner's own budget checks read the new total.
    const transition = staleReason ? keepStatus(state) : budgetTransition(state, totals, limits);
    if (!delta && !transition.dimension) {
        return {
            goal: state,
            decisionEpoch: state.updatedAt,
            transitioned: null,
            ...(staleReason ? { staleReason } : {}),
        };
    }
    const keepsDecisionEpoch = keepsChargeDecisionEpoch(state, staleReason);
    const decisionEpoch = keepsDecisionEpoch
        ? state.updatedAt
        : Math.max(nowMs(), state.updatedAt + 1);
    db.update(goals)
        .set({
        ...totals,
        status: transition.status,
        statusReason: transition.statusReason,
        updatedAtMs: decisionEpoch,
    })
        .where(eq(goals.goalId, binding.goalId))
        .run();
    return {
        goal: {
            ...state,
            ...totals,
            status: transition.status,
            statusReason: transition.statusReason,
            updatedAt: decisionEpoch,
            // This value is published as a `thread_goal.updated` event while the
            // row behind `getById` answers the API, so it has to agree with
            // `rowToThreadGoalState`: advancing the epoch retires the wait, and
            // keeping the epoch keeps whatever wait is still visible at it.
            executionWait: keepsDecisionEpoch ? state.executionWait : null,
        },
        decisionEpoch,
        transitioned: transition.dimension ?? null,
        ...(staleReason ? { staleReason } : {}),
    };
}
function chargedTotals(state, delta) {
    return {
        tokensUsed: state.tokensUsed + (delta?.tokens ?? 0),
        turnsUsed: state.turnsUsed + (delta?.mainTurns ?? 0),
        timeUsedSeconds: state.timeUsedSeconds + (delta?.activeSeconds ?? 0),
    };
}
/** The charged delta, or undefined when the Turn consumed nothing at all. */
function normalizeUsageDelta(delta) {
    const tokens = numericOrZero(delta.tokens);
    const activeSeconds = numericOrZero(delta.activeSeconds);
    const mainTurns = delta.mainTurns === 1 ? 1 : 0;
    return tokens === 0 && activeSeconds === 0 && mainTurns === 0
        ? undefined
        : { tokens, activeSeconds, mainTurns };
}
function budgetTransition(state, totals, limits) {
    // The work request budget is decided by settlement after the Turn's own
    // result and by admission, never by a usage charge.
    const dimension = state.status === 'active'
        ? firstExceededBudget({
            tokens: totals.tokensUsed,
            mainTurns: 0,
            activeSeconds: totals.timeUsedSeconds,
        }, limits)
        : undefined;
    return dimension
        ? { dimension, status: 'budget_limited', statusReason: `budget_limited(${dimension})` }
        : keepStatus(state);
}
function keepStatus(state) {
    return { dimension: undefined, status: state.status, statusReason: state.statusReason };
}
/*
 * The decision epoch is the token saying *who owns this Goal's next step*:
 * admission's final recheck, the pre-tool gate, the settlement CAS and the
 * execution-wait projection all read it as one. Advancing it therefore
 * retires whatever the Goal is currently running, and only a writer that
 * takes over the next step has the right to do that.
 *
 * A charge is not automatically such a writer. Two cases keep the epoch:
 *
 *  - `budget_limited`: the Goal already wrapped up and stopped inside its
 *    own Goal Turn (spec §5), so a later charge owns no next step. The
 *    user's way back — raising or clearing the token budget — is a
 *    versioned edit of this epoch (spec §9); advancing it would only make
 *    that edit conflict.
 *  - a stale charge, which never decides anything: the late subagent
 *    verifier being the only producer today. Its binding lost the epoch to
 *    a user's edit or breaker reset, so it owns no decision — but a Turn
 *    re-armed by that same change may already be running, and invalidating
 *    it here strands the Goal with no runner at all (the re-arm marker is
 *    already spent). That runner's own budget checks see the charged total.
 */
function keepsChargeDecisionEpoch(state, staleReason) {
    return state.status === 'budget_limited' || staleReason !== undefined;
}
/** Commit one host-owned terminal decision against the exact accounting epoch. */
export function settleThreadGoalBoundTurn(db, nowMs, input) {
    const state = readGoal(db, input.goalId);
    if (!state)
        return { status: 'stale', staleReason: 'missing_goal' };
    const stale = threadGoalStaleDecision(state, input);
    if (stale)
        return stale;
    const decisionEpoch = Math.max(nowMs(), input.expectedEpoch + 1);
    const workerProposal = materializeThreadGoalWorkerProposal(input.workerProposal, decisionEpoch);
    // The recovery schedule is committed in the same statement as the stop it
    // belongs to, so a crash can never leave a `usage_limited` Goal whose
    // schedule was written separately — the row is either the parked Goal with
    // its recovery time or the Goal as it was before.
    const usageRecoveryAtMs = settledUsageRecoveryAtMs(input);
    const result = db
        .update(goals)
        .set({
        status: input.next.status,
        statusReason: input.next.statusReason,
        updatedAtMs: decisionEpoch,
        usageRecoveryAtMs,
        ...(workerProposal ? { lastWorkerProposal: JSON.stringify(workerProposal) } : {}),
    })
        .where(and(eq(goals.goalId, input.goalId), eq(goals.updatedAtMs, input.expectedEpoch), eq(goals.status, 'active')))
        .run();
    if (result.changes === 0) {
        return (threadGoalStaleDecision(readGoal(db, input.goalId), input) ?? {
            status: 'stale',
            staleReason: 'goal_status',
        });
    }
    return {
        status: 'settled',
        decisionEpoch,
        goal: {
            ...state,
            status: input.next.status,
            statusReason: input.next.statusReason,
            updatedAt: decisionEpoch,
            ...(workerProposal ? { lastWorkerProposal: workerProposal } : {}),
            executionWait: null,
            usageRecoveryAtMs,
        },
    };
}
/**
 * The recovery time this stop should persist, or `null` for every other stop.
 *
 * Only an explicit account-quota stop carries a schedule. Any other terminal
 * reason clears the column so a Goal that was previously parked on a quota and
 * then stopped for a different reason cannot keep an obsolete timer.
 */
function settledUsageRecoveryAtMs(input) {
    if (input.next.statusReason !== THREAD_GOAL_AUTO_RECOVERABLE_USAGE_REASON)
        return null;
    const candidate = input.next.usageRecoveryAtMs;
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0) {
        return null;
    }
    return candidate;
}
function firstExceededBudget(usage, limits) {
    if (isPositiveLimit(limits.tokens) && usage.tokens >= limits.tokens)
        return 'token';
    if (isPositiveLimit(limits.mainTurns) && usage.mainTurns >= limits.mainTurns) {
        return 'main_turn';
    }
    if (isPositiveLimit(limits.activeSeconds) && usage.activeSeconds >= limits.activeSeconds) {
        return 'active_time';
    }
    return undefined;
}
function isPositiveLimit(value) {
    return value !== null && Number.isFinite(value) && value > 0;
}
function readGoal(db, goalId) {
    return readGoalRow(db, eq(goals.goalId, goalId));
}
//# sourceMappingURL=store-bound-settlement.js.map