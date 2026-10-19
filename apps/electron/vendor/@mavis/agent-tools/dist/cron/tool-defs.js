import { Type } from '@sinclair/typebox';
import { CRON_FIXED_SESSION_ID } from '../shared/cron-schedule-input.js';
export const CRON_TOOL_NAMES = [
    'self_reminder',
    'cron_create',
    'cron_read',
    'cron_update',
    'cron_delete',
];
const nonblank = (description) => Type.String({ minLength: 1, description });
/** 创建入口的 session 目标：`fixed` 建立任务专用会话，需要 `agent_name`。 */
const creationSession = Type.Object({
    mode: Type.String({
        enum: ['new', 'sessionId'],
        description: 'new starts a new conversation on every run; sessionId reuses one conversation across runs.',
    }),
    session_id: Type.Optional(nonblank(`In sessionId mode: "${CRON_FIXED_SESSION_ID}" or omitted creates a separate task-owned conversation on the first run, then reuses it. A real ID binds the user-selected existing conversation. "me" is invalid.`)),
}, { additionalProperties: false });
/** 更新入口的 session 目标：只接受真实会话 ID，不接受创建保留值。 */
const updateSession = Type.Object({
    mode: Type.String({
        enum: ['new', 'sessionId'],
        description: 'new starts a new conversation on every run; sessionId reuses the target conversation.',
    }),
    session_id: Type.Optional(nonblank('Required for sessionId mode: the real ID of an existing conversation. Re-pointing a task never creates a conversation.')),
}, { additionalProperties: false });
const prompt = nonblank('Task instructions. State the intended result and when follow-up is complete.');
const timezone = Type.Optional(nonblank('IANA timezone for the schedule.'));
const schedule = Type.Optional(nonblank('Five-field cron expression for a recurring task.'));
const enabled = Type.Optional(Type.Boolean({ description: 'false pauses the task; true resumes it.' }));
export function cronToolDefinitions(idField) {
    const identity = {
        [idField]: nonblank('Exact scheduled-task ID returned by cron_read or cron_create.'),
    };
    return [
        {
            name: 'cron_create',
            loading: 'on_demand',
            description: 'Create a user-requested recurring or one-time task. ' +
                'Clarify unclear task content or timing with ask_user. ' +
                'Describe fixed mode as a separate task-owned conversation (任务专用对话), reused across runs. ' +
                'Use self_reminder for follow-up on the current work. ' +
                'Do not repeat a successful creation.',
            schema: Type.Object({
                cron_name: nonblank('Natural-language task title.'),
                prompt,
                session: creationSession,
                agent_name: Type.Optional(nonblank('Agent name or "me". Required for new mode or a dedicated fixed conversation; omit when binding an existing session ID.')),
                schedule: Type.Optional(nonblank('Recurring five-field cron expression. Provide exactly one of schedule, after or at.')),
                after: Type.Optional(nonblank('One-time relative delay, such as 10m. Mutually exclusive with at and schedule.')),
                at: Type.Optional(Type.Union([Type.String(), Type.Number()], {
                    description: 'One-time future Unix milliseconds or date/time. Mutually exclusive with after and schedule.',
                })),
                timezone,
                enabled,
                model: Type.Optional(nonblank(idField === 'cron_id'
                    ? 'User-selected model name; omit to inherit the current model. Ambiguity returns candidates without creating a task.'
                    : 'Exact provider/model_id. Omit to inherit the current model.')),
                project: Type.Optional(nonblank('Project name, ID or local workspace path; omit to inherit the current task’s project.')),
            }, { additionalProperties: false }),
        },
        {
            name: 'cron_read',
            loading: 'on_demand',
            description: 'List scheduled tasks, inspect a task, or read its run history.',
            schema: Type.Object({
                view: Type.String({
                    enum: ['list', 'detail', 'runs'],
                    description: `detail and runs require ${idField}.`,
                }),
                [idField]: Type.Optional(identity[idField]),
                agent_name: Type.Optional(nonblank('Optional owner filter for list.')),
                cursor: Type.Optional(Type.String()),
                limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            }, { additionalProperties: false }),
        },
        {
            name: 'cron_update',
            loading: 'on_demand',
            description: `Update or pause/resume a scheduled task. ${idField === 'cron_id' ? 'Self-reminder sessions, models and workspaces stay fixed. ' : ''}Run immediately from the scheduling UI.`,
            schema: Type.Object({
                ...identity,
                schedule,
                timezone,
                enabled,
                prompt: Type.Optional(prompt),
                session: Type.Optional(updateSession),
            }, { additionalProperties: false }),
        },
        {
            name: 'cron_delete',
            loading: 'on_demand',
            description: 'Delete a scheduled task and stop future runs. Keep run history and conversations.',
            schema: Type.Object(identity, { additionalProperties: false }),
        },
    ];
}
export const LocalSelfReminderToolDef = {
    name: 'self_reminder',
    loading: 'default',
    description: 'Set or cancel a single follow-up check for external work in this conversation. Use only when no completion notification is available; never just to wait for a user reply. Only one unfinished reminder is allowed; another set returns SELF_REMINDER_EXISTS without changing it. Cancel when follow-up is no longer needed. For user-requested scheduled tasks, discover cron_create with tool_search.',
    schema: Type.Object({
        action: Type.String({
            enum: ['set', 'cancel'],
            description: 'set requires delay_seconds and prompt. cancel takes no other fields. To change the current reminder, cancel it before setting another.',
        }),
        delay_seconds: Type.Optional(Type.Integer({
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
            description: 'Positive integer seconds from now until the follow-up.',
        })),
        prompt: Type.Optional(Type.String({
            minLength: 1,
            pattern: '\\S',
            description: 'What to check and when to report the result; must contain non-whitespace text.',
        })),
    }, { additionalProperties: false }),
};
// 云端契约由云端 Cron 改造独立迁移。
export const SelfReminderToolDef = {
    name: 'self_reminder',
    loading: 'default',
    description: 'Set or cancel a follow-up reminder for your current task when external work has no completion notification. The runtime fixes the target to this conversation. For set, provide prompt and exactly one of after, at or every. Use after or at for a single future check; every repeats until cancelled or paused. Use action=cancel when recurring work is done or a pending check is no longer needed. Background tools that return their own completion need no reminder. Waiting for a user reply alone needs no reminder. For user-requested scheduled tasks, discover the Cron tools with tool_search.',
    schema: Type.Object({
        action: Type.String({ enum: ['set', 'cancel'] }),
        reminder_id: Type.Optional(nonblank('Required for cancel; ID returned by set.')),
        prompt: Type.Optional(prompt),
        every: Type.Optional(nonblank('Recurring interval: whole minutes, dividing one hour, from 1m to 1h. Mutually exclusive with after and at.')),
        after: Type.Optional(nonblank('Single check after a duration such as 10m or 1h30m. Mutually exclusive with every and at.')),
        at: Type.Optional(Type.Union([Type.String({ minLength: 1, pattern: '\\S' }), Type.Number()], {
            description: 'Single check at a future Unix millisecond timestamp or date-time. Include a timezone offset; without one the host timezone applies. Mutually exclusive with every and after.',
        })),
        name: Type.Optional(nonblank('Natural-language reminder title.')),
    }, { additionalProperties: false }),
};
export function cronCommand(name, args, idField) {
    if (name === 'cron_create') {
        const choices = [args.schedule, args.after, args.at].filter((value) => value !== undefined);
        if (choices.length !== 1)
            throw new Error('Provide exactly one of schedule, after or at.');
        if (args.schedule === undefined && args.enabled !== undefined)
            throw new Error('enabled is available for recurring creation. Use cron_update to pause a one-time task.');
        return args.schedule !== undefined ? 'cron create' : 'cron once';
    }
    if (name === 'cron_read') {
        if (args.view !== 'list' && !args[idField])
            throw new Error(`${idField} is required for detail and runs.`);
        return args.view === 'runs'
            ? 'cron sessions'
            : args.view === 'detail'
                ? 'cron get'
                : 'cron list';
    }
    return name === 'cron_update' ? 'cron update' : 'cron delete';
}
export function cronToolFailure(name, message, code = 'CRON_INVALID_INPUT') {
    const text = JSON.stringify({ ok: false, error: { code, message } });
    return { tool_name: name, text, content: [{ type: 'text', text }], isError: true };
}
/** 自提醒只接受整除一小时的整分钟间隔，两端共用同一输入规则。 */
export function selfReminderIntervalMinutes(every) {
    const match = /^(\d+)(m|h)$/.exec(every.trim());
    const minutes = match ? Number(match[1]) * (match[2] === 'h' ? 60 : 1) : 0;
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 60 && 60 % minutes === 0
        ? minutes
        : undefined;
}
//# sourceMappingURL=tool-defs.js.map