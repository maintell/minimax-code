import { ThreadGoalBudgetLimitedError, ThreadGoalEpochConflictError, ThreadGoalTokenBudgetExhaustedError, } from '@mavis/goal';
const GOAL_CHANGED_ERROR = 'goal changed; call get_goal again before updating the token budget';
/**
 * Refuse a `update_goal_budget` call the stored Goal cannot accept, or return
 * `undefined` when the write may proceed.
 */
export function rejectTokenBudgetMutation(existing, input) {
    const error = tokenBudgetMutationError(existing, input);
    return error ? { updated: false, error, currentGoal: existing } : undefined;
}
function tokenBudgetMutationError(existing, input) {
    if (existing.goalId !== input.expectedGoalId || existing.updatedAt !== input.expectedUpdatedAt) {
        return GOAL_CHANGED_ERROR;
    }
    if (existing.status === 'complete') {
        return 'cannot update the token budget of a complete goal';
    }
    if (typeof input.tokenBudget === 'number' && input.tokenBudget <= existing.tokensUsed) {
        return `token_budget must be greater than the goal's ${existing.tokensUsed} accounted tokens`;
    }
    if (existing.status === 'budget_limited' && existing.statusReason !== 'budget_limited(token)') {
        return `cannot resume ${existing.statusReason ?? 'budget_limited'} by changing the token budget`;
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