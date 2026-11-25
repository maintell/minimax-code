import { readPtcExecutionDetails } from '@mavis/agent-core/tools';
import { normalizeTodoItems, readCompactionCompatibility, TODO_CADENCE_INTERVAL, } from '../compat.js';
import { advanceAssistantIterationCadence } from './assistant-iteration-cadence.js';
import { isGenuineUserInput } from './genuine-user-query.js';
/** Version 1 marker type, kept for released histories. */
const TODO_CADENCE_REMINDER_CUSTOM_TYPE = 'todo_cadence_reminder';
/** Version 2 marker type; see canonical-history-validation for why it is new. */
export const TODO_REMINDER_CUSTOM_TYPE = 'todo_reminder';
/** Rebuilds Todo reminder state from the durable transcript. */
export function projectTodoHistory(messages) {
    const inherited = readCompactionCompatibility(messages[0]);
    let todoState = inherited?.todoState;
    let todoCadence = inherited?.todoCadence ?? {
        assistantIterationsSinceTodoWrite: TODO_CADENCE_INTERVAL,
        assistantIterationsSinceReminder: TODO_CADENCE_INTERVAL,
    };
    let userMessagesSinceTodoWrite = inherited?.todoUserMessagesSinceWrite ?? 0;
    const toolNames = new Map();
    messages.forEach((message) => {
        if (isGenuineUserInput(message))
            userMessagesSinceTodoWrite += 1;
        if (message.role === 'assistant') {
            todoCadence = {
                assistantIterationsSinceTodoWrite: advanceAssistantIterationCadence(todoCadence.assistantIterationsSinceTodoWrite),
                assistantIterationsSinceReminder: advanceAssistantIterationCadence(todoCadence.assistantIterationsSinceReminder),
            };
            recordToolNames(message, toolNames);
        }
        const next = readSuccessfulTodo(message, toolNames);
        if (next !== undefined) {
            todoState = next;
            todoCadence = { ...todoCadence, assistantIterationsSinceTodoWrite: 0 };
            userMessagesSinceTodoWrite = 0;
        }
        if (isTodoCadenceReminder(message)) {
            todoCadence = { ...todoCadence, assistantIterationsSinceReminder: 0 };
        }
    });
    return todoState === undefined ? {} : { todoState, todoCadence, userMessagesSinceTodoWrite };
}
function isTodoCadenceReminder(message) {
    const details = Reflect.get(message, 'details');
    return (message.role === 'custom' &&
        Reflect.get(message, 'display') === false &&
        details !== null &&
        typeof details === 'object' &&
        ((Reflect.get(message, 'customType') === TODO_CADENCE_REMINDER_CUSTOM_TYPE &&
            Reflect.get(details, 'version') === 1) ||
            (Reflect.get(message, 'customType') === TODO_REMINDER_CUSTOM_TYPE &&
                Reflect.get(details, 'version') === 2)) &&
        Array.isArray(Reflect.get(details, 'todos')));
}
function recordToolNames(message, toolNames) {
    if (message.role !== 'assistant' || !Array.isArray(message.content))
        return;
    message.content.forEach((block) => {
        if (!block || block.type !== 'toolCall')
            return;
        if (block.id.trim() && block.name.trim())
            toolNames.set(block.id, block.name.toLowerCase());
    });
}
function readSuccessfulTodo(message, toolNames) {
    if (message.role !== 'toolResult' || message.isError)
        return undefined;
    const toolName = message.toolName?.toLowerCase() ?? toolNames.get(message.toolCallId);
    // PTC keeps TodoWrite inside run_code, so its snapshot only exists as a
    // successful child call of the host-written envelope on that result.
    if (toolName === 'run_code')
        return readRunCodeTodo(message);
    if (toolName !== 'todowrite')
        return undefined;
    const details = Reflect.get(message, 'details');
    if (!details ||
        typeof details !== 'object' ||
        Reflect.get(details, 'cancelled') === true ||
        Reflect.get(details, 'status') === 'cancelled') {
        return undefined;
    }
    return normalizeTodoItems(Reflect.get(details, 'todos'));
}
/**
 * The Todo snapshot a run_code program left behind: the last successful
 * todowrite child call of that result, in call order. Only completed calls
 * count, because a failed, denied or outcome-unknown child may never have
 * written its list. Records written before the host kept child arguments
 * carry `input: {}`, which yields nothing instead of failing.
 */
function readRunCodeTodo(message) {
    const childCalls = readPtcExecutionDetails(message)?.child_calls;
    if (!childCalls)
        return undefined;
    let todoState;
    for (const call of childCalls) {
        if (call.tool_name !== 'todowrite')
            continue;
        if (call.status !== 'completed' || call.is_error === true || call.outcome_unknown === true) {
            continue;
        }
        const todos = normalizeTodoItems(call.input === undefined ? undefined : call.input.todos);
        if (todos)
            todoState = todos;
    }
    return todoState;
}
//# sourceMappingURL=todo-cadence.js.map