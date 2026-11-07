import { resolveUpdateGoalMode } from '@mavis/goal';
/**
 * Restricts only update_goal's budget mode; all other tool paths pass through.
 * A Turn carrying an explicit user request may adjust the limits. A Goal Turn
 * may set the limits its objective states, which the Goal only takes where it
 * has none yet (a kickoff, or the Turn after an objective edit reset them), so
 * it can tighten but never lift a limit.
 */
export function createGoalBudgetToolPolicyGuard(options) {
    return {
        async beforeToolCall(input) {
            if (input.toolContext.toolCall.name !== 'update_goal')
                return undefined;
            const args = readRecord(input.toolContext.args);
            if (resolveUpdateGoalMode(args) !== 'token_budget')
                return undefined;
            if (input.genuineUserQueryText.length > 0)
                return undefined;
            if (options.worksForGoal(input.turn))
                return undefined;
            return {
                block: true,
                reason: 'Goal token-budget updates require an explicit user request in the current turn; scheduled work, subagents, and background work cannot change the budget.',
            };
        },
    };
}
export function combineLocalTurnToolPolicyGuards(...guards) {
    return {
        async beforeToolCall(input) {
            for (const guard of guards) {
                const decision = await guard.beforeToolCall(input);
                if (decision !== undefined)
                    return decision;
            }
            return undefined;
        },
    };
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
//# sourceMappingURL=goal-budget-tool-policy.js.map