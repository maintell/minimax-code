import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { isAssignedByBunny } from '../../session-system/index.js';
const ASSIGNMENT_COMMANDS = {
    assignment_create: 'session create',
    assignment_send: 'session send',
    assignment_cancel: 'assignment cancel',
    assignment_stop: 'assignment stop',
};
/**
 * The assignment tools the hosted project-approval rule turns into an ask.
 *
 * `checkAssignmentPermission` reads only `session create` (a `project` arg) and
 * `session send` (`report_back`); `assignment cancel` / `assignment stop` map to
 * commands it never inspects, so they already keep the ordinary policy — and its
 * deny rules — untouched.
 */
export function isProjectApprovedAssignmentTool(toolName) {
    const command = ASSIGNMENT_COMMANDS[toolName];
    return command === 'session create' || command === 'session send';
}
/** An assignment tool is checked as the `mavis` command it stands for. */
export function assignmentPermissionInput(input) {
    const command = ASSIGNMENT_COMMANDS[input.toolName];
    if (!command)
        return input;
    return { ...input, toolName: 'mavis', toolInput: { command, args: mappedArgs(command, input) } };
}
/**
 * A plan built for the `mavis` command an assignment tool maps to records that
 * command as its original input, so the gate would reject it against the real
 * tool call. Assignment tools have no input rewrite; they run with their own input.
 */
export function withoutExecutionPlan(decision) {
    if (decision.behavior === 'deny' || !('executionPlan' in decision))
        return decision;
    const planless = { ...decision };
    delete planless.executionPlan;
    return planless;
}
/** Bunny's assignment tools always report back; saying so puts them under project approval. */
function mappedArgs(command, input) {
    if (command === 'session create' || command === 'session send')
        return { ...input.toolInput, report_back: true };
    return input.toolInput;
}
/**
 * Bunny assigning work into its own space directory: a create without a
 * project resolving to a space directory, or a follow-up to such a task.
 * Only this never asks; other callers and project targets keep project approval.
 */
export async function isDefaultWorkspaceAssignment({ sessions, tasks, resolveProject, }, callerSessionId, input) {
    const args = input.args;
    if (typeof args !== 'object' || args === null)
        return false;
    if (input.command !== 'session create' && input.command !== 'session send')
        return false;
    const caller = await sessions.get(callerSessionId);
    if (!caller || caller.archived || caller.agentName !== BUNNY_AGENT_NAME)
        return false;
    if (input.command === 'session create')
        return isDefaultCreate(args, () => resolveProject?.(callerSessionId, input));
    const target = await sendTarget(sessions, callerSessionId, args);
    if (!target?.isDefaultWorkspace)
        return false;
    return isAssignedByBunny(await tasks.get(target.sessionId));
}
async function isDefaultCreate(args, resolveProject) {
    const project = Reflect.get(args, 'project');
    if (project !== undefined)
        return typeof project === 'string' && project.trim() === 'default';
    if (Reflect.get(args, 'report_back') !== true)
        return false;
    return (await resolveProject()) === 'default';
}
async function sendTarget(sessions, callerSessionId, args) {
    const id = Reflect.get(args, 'session_id');
    if (typeof id !== 'string' || id === 'me' || id === callerSessionId)
        return undefined;
    const target = await sessions.get(id);
    return target && !target.archived ? target : undefined;
}
//# sourceMappingURL=tool-input.js.map