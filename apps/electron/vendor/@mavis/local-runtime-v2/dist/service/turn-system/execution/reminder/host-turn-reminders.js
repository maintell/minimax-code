import { createBackgroundCadenceReminder } from './background-cadence-reminder.js';
import { createMemorySummaryReminder } from './memory-summary-reminder.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';
/** Memory V2 off: nothing to show, so summaries left in history are withdrawn. */
const noMemorySummary = async () => undefined;
/** Host-owned Turn reminders that measure request budget against one usage anchor. */
export function createHostTurnReminders(usageAnchor, memorySummaryContext) {
    return {
        backgroundCadenceReminder: createBackgroundCadenceReminder(usageAnchor),
        // Installed even when Memory V2 is not assembled: Sessions that carried a
        // summary before must stop sending it, as when it lived in the system prompt.
        memorySummaryReminder: createMemorySummaryReminder(memorySummaryContext ?? noMemorySummary, usageAnchor),
        canAppendExecutionBudgetReminder: (input, marker) => fitsReminderInFinalRequest(input, marker, usageAnchor),
    };
}
//# sourceMappingURL=host-turn-reminders.js.map