import { ASSIGNMENT_TOOL_COMMANDS, isProjectApprovedAssignmentTool, } from '@mavis/agent-tools/namespaced-tools';
import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { isAssignedByBunny } from '../../session-system/index.js';
export { isProjectApprovedAssignmentTool };
/**
 * Bunny assigning work into its own space directory: a create without a
 * project resolving to a space directory, or a follow-up to such a task.
 * Only this never asks; other callers and project targets keep project approval.
 *
 * Read from the tool's own name and its own arguments, like every other reader
 * of an assignment call.
 */
export async function isDefaultWorkspaceAssignment({ sessions, tasks, resolveProject, }, callerSessionId, toolName, args) {
    const command = ASSIGNMENT_TOOL_COMMANDS[toolName];
    if (command !== 'session create' && command !== 'session send')
        return false;
    const caller = await sessions.get(callerSessionId);
    if (!caller || caller.archived || caller.agentName !== BUNNY_AGENT_NAME)
        return false;
    if (command === 'session create')
        return isDefaultCreate(args, () => resolveProject?.(callerSessionId, toolName, args));
    const target = await sendTarget(sessions, callerSessionId, args);
    if (!target?.isDefaultWorkspace)
        return false;
    return isAssignedByBunny(await tasks.get(target.sessionId));
}
async function isDefaultCreate(args, resolveProject) {
    const project = Reflect.get(args, 'project');
    if (project !== undefined)
        return typeof project === 'string' && project.trim() === 'default';
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