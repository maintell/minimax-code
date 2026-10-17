import { resolveUpdateGoalMode } from '@mavis/goal';
/** Restricts only update_goal's budget mode; all other tool paths pass through. */
export function createGoalBudgetToolPolicyGuard() {
    return {
        async beforeToolCall(input) {
            if (input.toolContext.toolCall.name !== 'update_goal')
                return undefined;
            const args = readRecord(input.toolContext.args);
            if (resolveUpdateGoalMode(args) !== 'token_budget')
                return undefined;
            if (input.genuineUserQueryText.length > 0)
                return undefined;
            return {
                block: true,
                reason: 'Goal token-budget updates require an explicit user request in the current turn; autonomous continuations, scheduled work, subagents, and background work cannot change the budget.',
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