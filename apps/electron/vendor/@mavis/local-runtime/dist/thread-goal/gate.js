import { GOAL_CONFIG_DEFAULTS, GOAL_CONFIG_LIMITS, resolveBetaFeature, } from '@mavis/config';
import { digestThreadGoalObjective, } from '@mavis/goal';
import { firstGoalBlocker } from './blockers.js';
export const GOAL_AUTOMATION_OWNER_CONFLICT = 'GOAL_AUTOMATION_OWNER_CONFLICT';
export class ThreadGoalSessionNotFoundError extends Error {
    statusCode = 404;
    code = 'SESSION_NOT_FOUND';
    constructor(sessionId) {
        super(`Session not found: ${sessionId}`);
    }
}
export class ThreadGoalAutomationOwnerConflictError extends Error {
    sessionId;
    name = 'ThreadGoalAutomationOwnerConflictError';
    statusCode = 409;
    code = GOAL_AUTOMATION_OWNER_CONFLICT;
    constructor(sessionId) {
        super(`Session already has an active Cron or AgentTeam automation owner: ${sessionId}`);
        this.sessionId = sessionId;
    }
}
export const GOAL_VERIFIER_SESSION_FORBIDDEN = 'GOAL_VERIFIER_SESSION_FORBIDDEN';
/**
 * Raised when a caller tries to start, reactivate, or re-aim a Goal on a Goal
 * verification child Session. That child cannot mutate files and has no
 * `update_goal` tool, so such a Goal can only loop until the breaker pauses it.
 *
 * Reading, user pause, and clear stay allowed, which is what lets a user stop
 * and delete a Goal that an earlier build already stored on such a Session.
 */
export class ThreadGoalVerifierSessionError extends Error {
    sessionId;
    name = 'ThreadGoalVerifierSessionError';
    statusCode = 409;
    code = GOAL_VERIFIER_SESSION_FORBIDDEN;
    constructor(sessionId) {
        super(`Goal verification child sessions cannot start, resume, or edit a Goal: ${sessionId}. Use the parent session instead.`);
        this.sessionId = sessionId;
    }
}
/**
 * Last Goal-owned policy decision before durable Turn admission. This is an
 * optimistic binding, not a lease: settlement must still compare the captured
 * epoch before attributing work or accepting completion.
 */
export async function finalRecheck(deps, input, configGetter) {
    const goal = await deps.getGoalBySession(input.sessionId);
    if (!goal || goal.goalId !== input.goalId) {
        return { decision: 'cancel', reason: 'stale(turn_binding)' };
    }
    if (goal.status !== 'active') {
        return { decision: 'defer', reason: 'deferred(goal_not_active)', goal };
    }
    if (goal.updatedAt !== input.expectedUpdatedAt) {
        return { decision: 'cancel', reason: 'stale(goal_epoch)', goal };
    }
    const objectiveDigest = digestThreadGoalObjective(goal.objective);
    if (objectiveDigest !== input.expectedObjectiveDigest) {
        return { decision: 'cancel', reason: 'stale(objective_digest)', goal };
    }
    const exhaustedDimension = firstExhaustedThreadGoalBudget({
        tokens: goal.tokensUsed,
        mainTurns: goal.turnsUsed,
        activeSeconds: goal.timeUsedSeconds,
    }, resolveThreadGoalBudgetLimits(goal, configGetter));
    if (exhaustedDimension) {
        return { decision: 'pause', reason: `budget_limited(${exhaustedDimension})`, goal };
    }
    // Same ordered gate list the queue-selection stage evaluates, so the wait
    // reason shown while the Goal is parked is the one that later admits it.
    const blocker = await firstGoalBlocker(deps, {
        sessionId: input.sessionId,
        goalId: goal.goalId,
    });
    if (blocker) {
        return { decision: 'defer', reason: `deferred(${blocker})`, goal, waitReason: blocker };
    }
    // Cancel this Goal snapshot instead of merely releasing it: a queued user
    // message behind the claimed Goal must be able to become the next Turn.
    if (await deps.hasPriorityMailboxWork(input.sessionId)) {
        return { decision: 'cancel', reason: 'deferred(user_work)', goal };
    }
    return {
        decision: 'ready',
        binding: {
            goalId: goal.goalId,
            admittedGoalUpdatedAt: goal.updatedAt,
            objectiveDigest,
            turnId: input.turnId,
        },
    };
}
export function resolveThreadGoalBudgetLimits(goal, configGetter) {
    const budget = configGetter?.().goal?.budget;
    return {
        tokens: goal.tokenBudget ?? positiveIntegerOrNull(budget?.defaultTokens),
        mainTurns: positiveIntegerOrNull(budget?.defaultMainTurns),
        activeSeconds: positiveIntegerOrNull(budget?.defaultActiveSeconds),
    };
}
export function firstExhaustedThreadGoalBudget(usage, limits) {
    if (isExhausted(usage.tokens, limits.tokens))
        return 'token';
    if (isExhausted(usage.mainTurns, limits.mainTurns))
        return 'main_turn';
    if (isExhausted(usage.activeSeconds, limits.activeSeconds))
        return 'active_time';
    return undefined;
}
export function isThreadGoalEnabled(configGetter) {
    return resolveBetaFeature('threadGoal', configGetter?.().beta?.threadGoal, {
        internalBuild: process.env.__MAVIS_BUILD_INTERNAL === 'true',
    });
}
export function threadGoalRepeatedReplyLimit(configGetter) {
    const configured = configGetter?.().goal?.breaker?.repeatedReplyLimit;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : GOAL_CONFIG_DEFAULTS.breaker.repeatedReplyLimit;
}
export function threadGoalBudgetGraceSteps(configGetter) {
    const configured = configGetter?.().goal?.budget?.graceSteps;
    return typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
        ? Math.min(Math.floor(configured), GOAL_CONFIG_LIMITS.budget.graceSteps)
        : GOAL_CONFIG_DEFAULTS.budget.graceSteps;
}
export function threadGoalRepeatedNotMetLimit(configGetter) {
    return positiveIntegerOrDefault(configGetter?.().goal?.verifier?.repeatedNotMetLimit, GOAL_CONFIG_DEFAULTS.verifier.repeatedNotMetLimit);
}
export function threadGoalVerifierEvidenceMode(configGetter) {
    const configured = configGetter?.().goal?.verifier?.evidence;
    return configured === 'transcript' ? 'transcript' : GOAL_CONFIG_DEFAULTS.verifier.evidence;
}
export function threadGoalEvaluatorMaxTokens(configGetter) {
    return positiveIntegerOrDefault(configGetter?.().goal?.evaluator?.maxTokens, GOAL_CONFIG_DEFAULTS.evaluator.maxTokens);
}
export function threadGoalSubagentMaxTokens(configGetter) {
    const configured = configGetter?.().goal?.subagent?.maxTokens;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? Math.floor(configured)
        : undefined;
}
function positiveIntegerOrDefault(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : fallback;
}
function positiveIntegerOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null;
}
function isExhausted(usage, limit) {
    return limit !== null && Number.isFinite(limit) && limit > 0 && usage >= limit;
}
//# sourceMappingURL=gate.js.map