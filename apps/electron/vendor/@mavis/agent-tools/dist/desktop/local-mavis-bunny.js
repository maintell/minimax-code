import { z } from 'zod';
import { RETIRED_SPACE_UPDATE_FIELD_ERROR } from './local-mavis-coordinator-text.js';
import { idString, LocalMavisValidationError, optionalString, requireSessionAdapter, success, } from './local-mavis-shared.js';
const worklineCreateSchema = z
    .object({
    name: idString,
    goal: optionalString,
    projects: z.array(idString).optional(),
})
    .strict();
/**
 * The space memory fields `space update` used to take. They now live in context.md's
 * `<summary>`; passing one is a clear error instead of a silent drop.
 */
const RETIRED_SPACE_UPDATE_FIELDS = ['instructions', 'decisions', 'next_steps'];
const worklineUpdateSchema = z
    .object({ space_id: idString, ...worklineCreateSchema.partial().shape })
    .passthrough()
    .superRefine((value, context) => {
    const retired = RETIRED_SPACE_UPDATE_FIELDS.filter((field) => field in value);
    if (retired.length)
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [retired[0]],
            message: RETIRED_SPACE_UPDATE_FIELD_ERROR,
        });
    const unknown = Object.keys(value).filter((key) => key !== 'space_id' &&
        !(key in worklineCreateSchema.shape) &&
        !RETIRED_SPACE_UPDATE_FIELDS.includes(key));
    if (unknown.length)
        context.addIssue({ code: z.ZodIssueCode.unrecognized_keys, keys: unknown });
})
    .transform(({ space_id, name, goal, projects }) => ({ space_id, name, goal, projects }));
const contextReadSchema = z.object({ space_id: idString }).strict();
/** Same limit and the same count (string length) as the runtime's SPACE_CONTEXT_SUMMARY_LIMIT. */
const SPACE_CONTEXT_SUMMARY_MAX = 32000;
/**
 * An over-long summary says how long it is and how much to cut, so Bunny can shorten it in
 * one go instead of guessing. The error map keeps `.max()` as a plain check, so the JSON
 * schema the run_code SDK prints still carries maxLength.
 */
const contextSummarySchema = z
    .string({
    errorMap: (issue, ctx) => issue.code === z.ZodIssueCode.too_big && typeof ctx.data === 'string'
        ? { message: spaceContextSummaryTooLong(ctx.data.length) }
        : { message: ctx.defaultError },
})
    .max(SPACE_CONTEXT_SUMMARY_MAX);
const contextSectionSchema = z
    .object({ heading: z.string().trim().min(1), content: z.string() })
    .strict();
const contextWriteSchema = z
    .object({
    space_id: idString,
    summary: contextSummarySchema.optional(),
    sections: z.array(contextSectionSchema).min(1).optional(),
    revision: idString,
    end_turn: z.boolean().optional(),
})
    .strict()
    .refine((value) => (value.summary === undefined) !== (value.sections === undefined), {
    message: 'summary 和 sections 只给一个：整份改写用 summary，只改几节用 sections',
});
function spaceContextSummaryTooLong(length) {
    return `当前 ${length} 个字符，上限 ${SPACE_CONTEXT_SUMMARY_MAX}，至少要删掉 ${length - SPACE_CONTEXT_SUMMARY_MAX} 个字符`;
}
const taskModelSetSchema = z.object({ model: idString }).strict();
export const BUNNY_MAVIS_COMMAND_SCHEMAS = {
    'space create': worklineCreateSchema.pick({ name: true, goal: true, projects: true }),
    'space update': worklineUpdateSchema,
    'space list': z.object({}).strict(),
    'space get': z.object({ space_id: idString }).strict(),
    'space context read': contextReadSchema,
    'space context write': contextWriteSchema,
    'project list': z.object({}),
    'task model list': z.object({}).strict(),
    'task model set': taskModelSetSchema,
};
export const BUNNY_MAVIS_COMMAND_HANDLERS = {
    'space create': handleWorklineCreate,
    'space update': handleWorklineUpdate,
    'space list': handleWorklineList,
    'space get': handleWorklineGet,
    'space context read': handleContextRead,
    'space context write': handleContextWrite,
    'project list': handleProjectList,
    'task model list': handleTaskModelList,
    'task model set': handleTaskModelSet,
};
/**
 * The createAssignment request of `assignment_create`.
 * `project` is passed through as given; the other optional fields are sent only when set,
 * and an empty string counts as unset.
 */
export function buildCreateAssignmentRequest(input) {
    return {
        callerSessionId: input.callerSessionId,
        project: input.project,
        ...(input.space ? { space: input.space } : {}),
        ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
        title: input.title,
        content: input.content,
        userWords: input.userWords,
        ...(input.doneWhen !== undefined ? { doneWhen: input.doneWhen } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.reportBack !== undefined ? { reportBack: input.reportBack } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
        ...(input.reviewOf ? { reviewOf: input.reviewOf } : {}),
        ...(input.callerTurnId ? { callerTurnId: input.callerTurnId } : {}),
    };
}
function requireBunnyCaller(ctx, message) {
    if (ctx.currentCoordinator !== true || !ctx.currentSessionId)
        throw new LocalMavisValidationError(message);
    return ctx.currentSessionId;
}
const WORKLINE_CALLER_ERROR = 'Only bunny sessions can manage worklines';
/** The adapter's optional handler, or an error naming the unavailable capability. */
function requireHandler(ctx, name, unavailable) {
    const handler = requireSessionAdapter(ctx)[name];
    if (!handler)
        throw new Error(unavailable);
    return handler;
}
async function handleWorklineCreate(ctx, args) {
    const callerSessionId = requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR);
    const handler = requireHandler(ctx, 'createWorkline', 'Workline creation is unavailable');
    return success(ctx.command, await handler({
        ...args,
        callerSessionId,
        ...(ctx.currentTurnId ? { callerTurnId: ctx.currentTurnId } : {}),
    }));
}
async function handleWorklineUpdate(ctx, args) {
    const callerSessionId = requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR);
    const handler = requireHandler(ctx, 'updateWorkline', 'Workline update is unavailable');
    const { space_id, ...changes } = args;
    return success(ctx.command, await handler({
        callerSessionId,
        workline_id: space_id,
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.goal !== undefined ? { goal: changes.goal } : {}),
        ...(changes.projects !== undefined ? { projects: changes.projects } : {}),
    }));
}
// get and project list report an unavailable handler before checking the caller.
async function handleWorklineGet(ctx, args) {
    const handler = requireHandler(ctx, 'getWorkline', 'Space details are unavailable');
    return success(ctx.command, await handler({
        callerSessionId: requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR),
        spaceId: args.space_id,
    }));
}
async function handleContextRead(ctx, args) {
    const handler = requireHandler(ctx, 'readSpaceContext', 'Space context is unavailable');
    return success(ctx.command, await handler({
        callerSessionId: requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR),
        spaceId: args.space_id,
    }));
}
async function handleContextWrite(ctx, args) {
    const handler = requireHandler(ctx, 'writeSpaceContext', 'Space context is unavailable');
    return success(ctx.command, await handler({
        callerSessionId: requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR),
        spaceId: args.space_id,
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(args.sections ? { sections: args.sections } : {}),
        revision: args.revision,
    }));
}
async function handleProjectList(ctx) {
    const handler = requireHandler(ctx, 'listProjects', 'Project listing is unavailable');
    return success(ctx.command, await handler({ callerSessionId: requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR) }));
}
const TASK_MODEL_CALLER_ERROR = 'Only bunny sessions can manage the task model';
async function handleTaskModelList(ctx) {
    const handler = requireHandler(ctx, 'listTaskModels', 'Task model listing is unavailable');
    return success(ctx.command, await handler({ callerSessionId: requireBunnyCaller(ctx, TASK_MODEL_CALLER_ERROR) }));
}
async function handleTaskModelSet(ctx, args) {
    const handler = requireHandler(ctx, 'setTaskModel', 'Task model update is unavailable');
    return success(ctx.command, await handler({
        callerSessionId: requireBunnyCaller(ctx, TASK_MODEL_CALLER_ERROR),
        model: args.model,
    }));
}
async function handleWorklineList(ctx) {
    const callerSessionId = requireBunnyCaller(ctx, WORKLINE_CALLER_ERROR);
    const handler = requireHandler(ctx, 'listWorklines', 'Workline listing is unavailable');
    return success(ctx.command, await handler({ callerSessionId }));
}
/** First prompt line that ties a coordinator schedule to one of its task spaces; stored as is. */
const SPACE_MARKER = /^<!-- bunny-space:[A-Za-z0-9_-]+ -->\r?\n/;
/**
 * Prompt of a schedule the coordinator creates with `space`: the marker line ties it to that
 * task space. Only the coordinator passes `space` (the dispatcher rejects it for any other
 * Agent), and only for a schedule that wakes the coordinator itself.
 */
export function coordinatorSchedulePrompt(ctx, agentName, prompt, space) {
    if (space === undefined)
        return prompt;
    if (ctx.currentCoordinator !== true || agentName !== ctx.currentAgentName)
        throw new LocalMavisValidationError('space is only supported for Bunny schedules');
    return `<!-- bunny-space:${space} -->\n${prompt}`;
}
/**
 * The task space of a coordinator schedule lives only in its stored prompt, so replacing that
 * prompt carries the existing marker over, whoever makes the edit; otherwise one edit silently
 * unlinks the space. Whether the schedule is a coordinator's comes from its owner's trusted
 * capability, not from the caller; a host without such Agents never reads the stored schedule.
 */
export async function keepScheduleSpaceMarker(adapter, cronId, prompt, signal) {
    if (!adapter.targetsMainConversation || SPACE_MARKER.test(prompt))
        return prompt;
    const current = (await adapter.getCron({ cronId }, signal)).task;
    if (!current?.agentName || !adapter.targetsMainConversation(current.agentName))
        return prompt;
    const marker = SPACE_MARKER.exec(current.prompt ?? '');
    return marker ? `${marker[0]}${prompt}` : prompt;
}
//# sourceMappingURL=local-mavis-bunny.js.map