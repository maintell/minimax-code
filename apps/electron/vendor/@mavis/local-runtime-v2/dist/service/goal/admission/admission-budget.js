import { digestThreadGoalObjective, } from '@mavis/goal';
import { firstExhaustedThreadGoalBudget, resolveThreadGoalBudgetLimits, threadGoalBudgetGraceSteps, } from '../lifecycle/gate.js';
/** Enforce the live Goal budget immediately before a v2 tool call. */
export async function checkThreadGoalTurnBudget(input, deps) {
    const boundTurn = deps.turnContext.getBinding(input.turnId);
    if (!boundTurn)
        return { decision: 'allow' };
    let goal;
    try {
        goal = await deps.store().getById(boundTurn.binding.goalId);
    }
    catch (error) {
        deps.failures.report(input.sessionId, `thread_goal_budget_check_failed:${deps.failures.format(error)}`);
        return {
            decision: 'stop',
            message: 'GOAL_BUDGET_CHECK_UNAVAILABLE: Tool execution is disabled because the Goal budget check failed closed.',
        };
    }
    // The user deleted the Goal while it was read: the Turn was detached first
    // and goes on as an ordinary Turn, whose tools are not fenced.
    if (deps.turnContext.getBinding(input.turnId) !== boundTurn)
        return { decision: 'allow' };
    if (!goal || !isBoundGoalCurrent(goal, input.sessionId, boundTurn.binding)) {
        return {
            decision: 'stop',
            message: 'GOAL_TURN_NOT_CURRENT: This Goal turn is no longer current. Do not call another tool; provide a brief final response.',
        };
    }
    const timing = deps.turnTimingReader.getByTurn(input.sessionId, input.turnId);
    const activeSeconds = timing ? deps.turnTimingReader.elapsedSeconds(timing) : 0;
    // Every settled request already charged its tokens to the Goal, so the
    // persisted total is current. The request budget closes the Turn at the next
    // request boundary instead of cutting off the last request's tool calls, so
    // it is not fenced here.
    const dimension = firstExhaustedThreadGoalBudget({
        tokens: goal.tokensUsed,
        mainTurns: 0,
        activeSeconds: goal.timeUsedSeconds + activeSeconds,
    }, resolveThreadGoalBudgetLimits(goal, deps.configGetter));
    if (!dimension)
        return { decision: 'allow' };
    if (boundTurn.graceStepsUsed < threadGoalBudgetGraceSteps(deps.configGetter)) {
        boundTurn.graceStepsUsed += 1;
        return {
            decision: 'steer',
            message: `GOAL_BUDGET_EXHAUSTED(${dimension}): The Goal budget is exhausted. Do not call another tool; respond now with a concise final summary.`,
        };
    }
    return {
        decision: 'stop',
        message: `GOAL_BUDGET_EXHAUSTED(${dimension}): Tool execution remains disabled for this Goal turn.`,
    };
}
function isBoundGoalCurrent(goal, sessionId, binding) {
    return (goal.sessionId === sessionId &&
        goal.status === 'active' &&
        goal.updatedAt === binding.admittedGoalUpdatedAt &&
        digestThreadGoalObjective(goal.objective) === binding.objectiveDigest);
}
//# sourceMappingURL=admission-budget.js.map