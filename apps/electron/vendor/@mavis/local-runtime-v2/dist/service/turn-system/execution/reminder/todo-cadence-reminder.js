import { summarizeTodoStatuses } from '@mavis/system-reminder';
import { formatTodoCadenceReminderContent } from '../../agent-host/history/canonical-history-validation.js';
import { TODO_CADENCE_REMINDER_CUSTOM_TYPE, projectTodoHistory, } from '../../compaction/algorithm/todo-cadence.js';
import { TODO_CADENCE_INTERVAL } from '../../compaction/compat.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';
/** Periodic reminder derived only from durable canonical history. */
export function createTodoCadenceReminderHook(usageAnchor) {
    return (input) => {
        if (!input.tools?.some((tool) => tool.name.toLowerCase() === 'todowrite'))
            return undefined;
        const projection = projectTodoHistory(input.canonicalMessages);
        if (!projection.todoState || !projection.todoCadence)
            return undefined;
        const summary = summarizeTodoStatuses(projection.todoState.map((todo) => ({ status: todo.status })));
        if (summary.active === 0 ||
            projection.todoCadence.assistantIterationsSinceTodoWrite < TODO_CADENCE_INTERVAL ||
            projection.todoCadence.assistantIterationsSinceReminder < TODO_CADENCE_INTERVAL) {
            return undefined;
        }
        const details = {
            version: 1,
            summary,
            todos: projection.todoState,
            cadence: projection.todoCadence,
        };
        const marker = {
            role: 'custom',
            customType: TODO_CADENCE_REMINDER_CUSTOM_TYPE,
            content: formatTodoCadenceReminderContent(details),
            display: false,
            details,
            timestamp: Date.now(),
        };
        if (!fitsReminderInFinalRequest(input, marker, usageAnchor)) {
            return undefined;
        }
        return {
            type: 'appendMessage',
            reason: TODO_CADENCE_REMINDER_CUSTOM_TYPE,
            message: marker,
        };
    };
}
//# sourceMappingURL=todo-cadence-reminder.js.map