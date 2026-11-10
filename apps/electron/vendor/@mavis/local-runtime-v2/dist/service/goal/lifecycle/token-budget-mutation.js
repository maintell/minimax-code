import { ThreadGoalBudgetLimitedError, ThreadGoalEpochConflictError, ThreadGoalTokenBudgetExhaustedError, } from '@mavis/goal';
const GOAL_CHANGED_ERROR = 'goal changed; call get_goal again before updating the token budget';
const LIMIT_NAMES = [
    'tokenBudget',
    'requestLimit',
    'activeSecondsLimit',
];
const LIMIT_FIELDS = {
    tokenBudget: 'token_budget',
    requestLimit: 'request_limit',
    activeSecondsLimit: 'active_seconds_limit',
};
/** The Goal's own stored limits (`null` = none; the global default applies). */
export function ownGoalLimits(goal) {
    return {
        tokenBudget: goal.tokenBudget,
        requestLimit: goal.requestLimit ?? null,
        activeSecondsLimit: goal.activeSecondsLimit ?? null,
    };
}
/** The limits this call asks to change; omitted limits stay as they are. */
export function requestedGoalLimits(input) {
    const requested = {};
    for (const name of LIMIT_NAMES) {
        const value = input[name];
        if (value !== undefined)
            requested[name] = value;
    }
    return requested;
}
/**
 * Split a budget update made inside the Goal's own Turn (spec 6.6). The only
 * user text such a Turn carries is the objective, so its numbers come from the
 * objective; a limit the user already set (the `/goal budget=` command at
 * creation, the API, an earlier explicit request) wins and is kept. Only
 * limits the Goal does not have yet are filled; clearing is never applied.
 */
export function partitionGoalTurnLimits(existing, requested) {
    const own = ownGoalLimits(existing);
    const apply = {};
    const kept = [];
    for (const name of LIMIT_NAMES) {
        const value = requested[name];
        if (value === undefined)
            continue;
        if (own[name] !== null || value === null)
            kept.push(name);
        else
            apply[name] = value;
    }
    return { apply, kept };
}
/**
 * Refuse a budget-mode `update_goal` call the stored Goal cannot accept, or
 * return `undefined` when the write may proceed.
 */
export function rejectTokenBudgetMutation(existing, input, scope = 'user') {
    const error = tokenBudgetMutationError(existing, input, scope);
    return error ? { updated: false, error, currentGoal: existing } : undefined;
}
function tokenBudgetMutationError(existing, input, scope) {
    if (existing.goalId !== input.expectedGoalId || existing.updatedAt !== input.expectedUpdatedAt) {
        return GOAL_CHANGED_ERROR;
    }
    if (existing.status === 'complete') {
        return 'cannot update the token budget of a complete goal';
    }
    const exhausted = exhaustedLimitError(existing, input, scope);
    if (exhausted)
        return exhausted;
    if (existing.status === 'budget_limited' && existing.statusReason !== 'budget_limited(token)') {
        return `cannot resume ${existing.statusReason ?? 'budget_limited'} by changing the token budget`;
    }
    return undefined;
}
/**
 * A user's new limit must exceed what the Goal already used in that dimension;
 * the Goal's own Turn may set any positive one (see `TokenBudgetMutationScope`).
 */
function exhaustedLimitError(existing, input, scope) {
    if (scope === 'goal_turn')
        return undefined;
    const used = {
        tokenBudget: { value: existing.tokensUsed, unit: 'accounted tokens' },
        requestLimit: {
            value: existing.accounting?.workOccupied ?? existing.turnsUsed,
            unit: 'counted work requests',
        },
        activeSecondsLimit: { value: existing.timeUsedSeconds, unit: 'seconds of execution time' },
    };
    for (const name of LIMIT_NAMES) {
        const value = input[name];
        if (typeof value !== 'number')
            continue;
        if (value <= used[name].value) {
            return `${LIMIT_FIELDS[name]} must be greater than the goal's ${used[name].value} ${used[name].unit}`;
        }
    }
    return undefined;
}
/**
 * Translate a store conflict raised by a concurrent writer into the tool's
 * rejection, or return `undefined` for a failure the caller must rethrow.
 */
export function tokenBudgetConflictResult(error, currentGoal) {
    const message = tokenBudgetConflictMessage(error);
    if (!message)
        return undefined;
    return { updated: false, error: message, ...(currentGoal ? { currentGoal } : {}) };
}
/** The rejection when a Goal Turn's limit write lost its epoch to another writer. */
export function goalChangedResult(currentGoal) {
    return { updated: false, error: GOAL_CHANGED_ERROR, ...(currentGoal ? { currentGoal } : {}) };
}
function tokenBudgetConflictMessage(error) {
    if (error instanceof ThreadGoalEpochConflictError)
        return GOAL_CHANGED_ERROR;
    if (error instanceof ThreadGoalTokenBudgetExhaustedError) {
        return `token_budget must be greater than the goal's ${error.tokensUsed} accounted tokens`;
    }
    if (error instanceof ThreadGoalBudgetLimitedError) {
        return 'cannot resume this budget-limited goal by changing the token budget';
    }
    return undefined;
}
//# sourceMappingURL=token-budget-mutation.js.map