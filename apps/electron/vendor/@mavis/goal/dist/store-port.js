/**
 * `ThreadGoalStore` —— pluggable persistence interface. agent-core is
 * IO-free; concrete implementations live in host packages
 * (`local-runtime/SqliteThreadGoalStore`, future `cloud-runtime/…`).
 *
 * The store is the single source of truth for goal state. Tool impls,
 * the HTTP API, the orchestrator, and the UI projection all funnel
 * through this contract so SSE events can be derived from store writes
 * deterministically.
 */
/**
 * Sentinel error thrown by `create()` when an unfinished goal (any
 * status other than `complete`) already exists for the session. Hosts
 * can pattern-match on `instanceof` to map it to HTTP 409 or the
 * codex-verbatim tool rejection text.
 */
export class ThreadGoalAlreadyExistsError extends Error {
    existingGoalId;
    constructor(existingGoalId) {
        super(`Unfinished thread goal already exists (goalId=${existingGoalId}).`);
        this.name = 'ThreadGoalAlreadyExistsError';
        this.existingGoalId = existingGoalId;
    }
}
/**
 * Raised when a patch observes a status it may not move away from. The
 * model-facing tool sets an explicit guard status and maps this to a normal
 * tool rejection; a user-authored PATCH hits it only on a transition the
 * surface refuses outright, `complete` back to `active` among them.
 */
export class ThreadGoalStatusConflictError extends Error {
    goalId;
    currentStatus;
    constructor(goalId, currentStatus) {
        super(`Thread goal status conflict (goalId=${goalId}, currentStatus=${currentStatus}).`);
        this.goalId = goalId;
        this.currentStatus = currentStatus;
        this.name = 'ThreadGoalStatusConflictError';
    }
}
/** Raised when a guarded model status write observes a newer objective. */
export class ThreadGoalObjectiveConflictError extends Error {
    goalId;
    expectedObjective;
    currentObjective;
    constructor(goalId, expectedObjective, currentObjective) {
        super(`Thread goal objective conflict (goalId=${goalId}).`);
        this.goalId = goalId;
        this.expectedObjective = expectedObjective;
        this.currentObjective = currentObjective;
        this.name = 'ThreadGoalObjectiveConflictError';
    }
}
/** Raised when a budget-exhausted Goal is explicitly rearmed. */
export class ThreadGoalBudgetLimitedError extends Error {
    goalId;
    code = 'GOAL_BUDGET_LIMITED';
    constructor(goalId) {
        super(`Budget-limited thread goal cannot be resumed (goalId=${goalId}).`);
        this.goalId = goalId;
        this.name = 'ThreadGoalBudgetLimitedError';
    }
}
/** Raised when a token cap would already be exhausted by accounted usage. */
export class ThreadGoalTokenBudgetExhaustedError extends Error {
    goalId;
    tokensUsed;
    tokenBudget;
    code = 'GOAL_TOKEN_BUDGET_EXHAUSTED';
    constructor(goalId, tokensUsed, tokenBudget) {
        super(`Token budget must exceed accounted usage (goalId=${goalId}, tokensUsed=${tokensUsed}, tokenBudget=${tokenBudget}).`);
        this.goalId = goalId;
        this.tokensUsed = tokensUsed;
        this.tokenBudget = tokenBudget;
        this.name = 'ThreadGoalTokenBudgetExhaustedError';
    }
}
/** Raised when a guarded write no longer matches the Goal decision epoch. */
export class ThreadGoalEpochConflictError extends Error {
    goalId;
    expectedUpdatedAt;
    currentUpdatedAt;
    code = 'GOAL_EPOCH_CONFLICT';
    constructor(goalId, expectedUpdatedAt, currentUpdatedAt) {
        super(`Thread goal decision epoch changed (goalId=${goalId}).`);
        this.goalId = goalId;
        this.expectedUpdatedAt = expectedUpdatedAt;
        this.currentUpdatedAt = currentUpdatedAt;
        this.name = 'ThreadGoalEpochConflictError';
    }
}
//# sourceMappingURL=store-port.js.map