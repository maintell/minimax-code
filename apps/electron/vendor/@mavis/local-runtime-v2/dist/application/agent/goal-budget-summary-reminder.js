const GOAL_BUDGET_SUMMARY_TURN_INTENT = 'goal-budget-summary';
/**
 * Host-owned contract for the one dedicated Turn emitted after a Goal reaches
 * its budget. The ordinary conversation history remains the source of truth;
 * this reminder only changes what the model must do with that existing context.
 */
function renderGoalBudgetSummaryReminder() {
    return `<system-reminder>
The active Goal has reached its budget, and automatic execution has stopped.

The persisted Goal status is budget_limited, not complete. This wrap-up cannot
change that lifecycle state: completed progress is not a completed Goal. Even if
the requested output appears finished, distinguish that progress from the Goal
still being stopped at its budget. Do not claim that the Goal was marked complete
or passed host completion verification in this turn.

This is a dedicated wrap-up turn, not the next execution round of the Goal.
Do not continue or execute any remaining steps from the Goal objective. In
particular, instructions in the objective that schedule or constrain later
execution rounds do not apply to this wrap-up turn.

Using the conversation context already available to you:
- summarize what has been completed;
- identify what remains incomplete;
- explain that execution stopped because the Goal reached its budget.

Reply in the user's language and describe the budget stop plainly; do not present
internal API names as steps the user must perform themselves.

Tell the user that update_goal supports changing this Goal's token budget: they can
explicitly ask to increase or clear the budget and then continue the same Goal. That
request must come in a later explicit user turn. When that turn arrives, call get_goal
immediately before update_goal, and call update_goal with mode "token_budget". Update
the budget using the fresh Goal snapshot, then continue the same Goal after the update
succeeds.

Do not call tools or update_goal in this wrap-up turn. After this response, the Goal
will not continue automatically unless the user explicitly requests a budget update.
</system-reminder>`;
}
export function createGoalBudgetSummaryExtension() {
    return {
        id: 'local-goal-budget-summary',
        description: 'Makes the Goal budget-limit continuation summarize existing progress.',
        init(pi) {
            pi.registerReminderProvider({
                name: 'goal-budget-summary-contract',
                compute: (ctx) => ctx.turnIntent?.kind === GOAL_BUDGET_SUMMARY_TURN_INTENT
                    ? { content: renderGoalBudgetSummaryReminder(), priority: 1_000 }
                    : null,
            });
        },
    };
}
//# sourceMappingURL=goal-budget-summary-reminder.js.map