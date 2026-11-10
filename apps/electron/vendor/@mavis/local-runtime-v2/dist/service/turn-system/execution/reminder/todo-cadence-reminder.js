import { summarizeTodoStatuses } from '@mavis/system-reminder';
import { formatTodoCadenceReminderContent } from '../../agent-host/history/canonical-history-validation.js';
import { TODO_REMINDER_CUSTOM_TYPE, projectTodoHistory, } from '../../compaction/algorithm/todo-cadence.js';
import { TODO_REMINDER_INTERVAL, TODO_REMINDER_STALE_USER_MESSAGES, } from '../../compaction/compat.js';
import { fitsReminderInFinalRequest } from './reminder-admission.js';
/**
 * Periodic reminder derived only from durable canonical history.
 *
 * `hasPtcChildTodoWrite` answers, for one Session's current Turn, whether
 * TodoWrite is reachable through run_code's child catalog. Production binds
 * it to the host's own object registration (execution/ptc/catalog.ts
 * hasPtcTurnChildTodoWrite); PTC hides TodoWrite from the provider tool list,
 * so without it this reminder would never fire on a PTC Turn. The answer
 * comes from the registered tool object, never from a tool description.
 */
export function createTodoCadenceReminderHook(usageAnchor, hasPtcChildTodoWrite = () => false) {
    return (input) => {
        const todoWriteCallable = input.tools?.some((tool) => tool.name.toLowerCase() === 'todowrite') === true ||
            hasPtcChildTodoWrite(input.sessionId);
        if (!todoWriteCallable)
            return undefined;
        const projection = projectTodoHistory(input.canonicalMessages);
        if (!projection.todoState || !projection.todoCadence)
            return undefined;
        const summary = summarizeTodoStatuses(projection.todoState.map((todo) => ({ status: todo.status })));
        if (!isTodoReminderDue(summary.active, projection.todoCadence, projection))
            return undefined;
        const details = {
            version: 2,
            summary,
            todos: projection.todoState,
            cadence: projection.todoCadence,
        };
        const marker = {
            role: 'custom',
            customType: TODO_REMINDER_CUSTOM_TYPE,
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
            reason: TODO_REMINDER_CUSTOM_TYPE,
            message: marker,
        };
    };
}
/**
 * Due when active Todos went untouched, and unreminded, for the interval. A
 * list that three user messages passed by belongs to work the user moved on
 * from, so it is left alone until the model writes the list again.
 */
function isTodoReminderDue(active, cadence, projection) {
    return (active > 0 &&
        (projection.userMessagesSinceTodoWrite ?? 0) < TODO_REMINDER_STALE_USER_MESSAGES &&
        cadence.assistantIterationsSinceTodoWrite >= TODO_REMINDER_INTERVAL &&
        cadence.assistantIterationsSinceReminder >= TODO_REMINDER_INTERVAL);
}
//# sourceMappingURL=todo-cadence-reminder.js.map