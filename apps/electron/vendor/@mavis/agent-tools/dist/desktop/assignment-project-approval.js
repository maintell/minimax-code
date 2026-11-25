import { namesSessionCreateScope } from './session-create-scope.js';
/**
 * The mavis command each of Bunny's `assignment_*` tools stands for.
 *
 * This is the one table: the project-approval command map, Bunny's dispatch
 * allowance and the permission-rule widening all derive from it, so adding a
 * dispatch tool is a single edit here.
 */
export const ASSIGNMENT_TOOL_COMMANDS = {
    assignment_create: 'session create',
    assignment_send: 'session send',
    assignment_cancel: 'assignment cancel',
    assignment_stop: 'assignment stop',
};
/**
 * The mavis command each tool with assignment semantics stands for. A project
 * approval rule is stored as `<command>:<project>`, so this is what a rule
 * written for one of these tools shares with a rule written for `mavis`.
 *
 * `session_create` is not an assignment tool but carries the same project
 * approval, so it joins the table's commands under its own name.
 */
const ASSIGNMENT_APPROVAL_COMMANDS = {
    ...ASSIGNMENT_TOOL_COMMANDS,
    session_create: 'session create',
};
/** The mavis command this tool's project approval is stored and matched under. */
export function assignmentApprovalCommand(toolName) {
    return ASSIGNMENT_APPROVAL_COMMANDS[toolName];
}
/**
 * The assignment tools whose command the project-approval rule inspects, and the
 * ones Bunny's own dispatch allowance covers. `assignment cancel` /
 * `assignment stop` map to commands project approval never reads, so they keep
 * the ordinary policy — and its deny rules — untouched.
 */
export function isProjectApprovedAssignmentTool(toolName) {
    const command = ASSIGNMENT_TOOL_COMMANDS[toolName];
    return command === 'session create' || command === 'session send';
}
/**
 * The tool names a stored project rule may carry. `mavis` stays so a rule the
 * user saved before these tools existed keeps matching; a new rule is written
 * under the tool's own name, and every name here reads the same pattern, so
 * approving one of them for a project still covers the others.
 */
export const ASSIGNMENT_RULE_TOOL_NAMES = new Set([
    'mavis',
    ...Object.keys(ASSIGNMENT_APPROVAL_COMMANDS),
]);
/**
 * Whether this call asks the user to approve the project it dispatches into.
 * Read from the tool's own name and its own arguments, on every route.
 */
export function needsAssignmentProjectApproval(toolName, args, callerSessionId) {
    const command = ASSIGNMENT_APPROVAL_COMMANDS[toolName];
    if (command === 'session create') {
        // session_create names where it works; assignment_create carries the
        // project it dispatches into.
        return toolName === 'session_create'
            ? namesSessionCreateScope(args)
            : Reflect.get(args, 'project') !== undefined;
    }
    if (command !== 'session send')
        return false;
    const target = Reflect.get(args, 'session_id');
    return target !== 'me' && target !== callerSessionId;
}
//# sourceMappingURL=assignment-project-approval.js.map