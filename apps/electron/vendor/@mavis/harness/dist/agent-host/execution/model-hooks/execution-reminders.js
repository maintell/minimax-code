import { createExecutionBudgetReminder } from '../../runner/reminder/execution-budget-reminder.js';
/**
 * All reminders append durable hidden markers and `runBeforeLLM` accumulates
 * them, so none can starve another. The order fixes where the markers sit
 * relative to each other, identically in the request and in history: the
 * restored Memory summary comes first because it is context for everything
 * after it, and the budget admission measures the request before the
 * background marker is registered.
 */
export async function prepareTurnReminders(input) {
    const { options } = input;
    const memorySummary = input.lightweightMode || !options.memorySummaryReminder
        ? { beforeUserMessages: [], hooks: [] }
        : await options.memorySummaryReminder.prepare({ hookInput: input.background.hookInput });
    // Lightweight mode drops it entirely, like the Memory summary; a Turn without
    // PTC has no run_code, so its loader withdraws the copies instead.
    const ptcScripts = input.lightweightMode || !options.ptcScriptCatalogReminder
        ? { beforeUserMessages: [], hooks: [] }
        : await options.ptcScriptCatalogReminder.prepare({ hookInput: input.background.hookInput });
    const context = {
        beforeUserMessages: [...memorySummary.beforeUserMessages, ...ptcScripts.beforeUserMessages],
        hooks: [...memorySummary.hooks, ...ptcScripts.hooks],
    };
    if (input.suppressed)
        return context;
    const background = await options.backgroundCadenceReminder?.prepare(input.background);
    const budgetReminder = createExecutionBudgetReminder(input.executionDeadlineAtMs, options.nowMs, options.canAppendExecutionBudgetReminder, options.logger);
    return {
        beforeUserMessages: [...context.beforeUserMessages, ...(background?.beforeUserMessages ?? [])],
        hooks: [
            ...context.hooks,
            ...(budgetReminder ? [budgetReminder] : []),
            ...(background ? [background.hook] : []),
        ],
    };
}
//# sourceMappingURL=execution-reminders.js.map