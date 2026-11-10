import { resolveThreadGoalBudgetLimits } from '../lifecycle/gate.js';
/** Budget limits for this Goal, falling back to config defaults when it is gone. */
export function effectiveGoalBudgetLimits(goal, configGetter) {
    return resolveThreadGoalBudgetLimits(goal ?? { tokenBudget: null }, configGetter);
}
//# sourceMappingURL=settlement-gates.js.map