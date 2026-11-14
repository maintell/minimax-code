import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { coordinatorToolDefinition } from '@mavis/agent-tools';
const SEND_TO_USER_TOOL = 'send_to_user';
const REMEMBER_TOOL = 'remember';
const COORDINATOR_ONLY_TOOL_NAMES = new Set([
    'assignment_create',
    'assignment_send',
    'assignment_cancel',
    'assignment_stop',
    'assignment_summary',
    REMEMBER_TOOL,
    SEND_TO_USER_TOOL,
    'working_state',
]);
/**
 * Tools a coordinator never needs, whatever its declaration says. Deploying a site,
 * authoring a model access extension and keeping an in-turn todo list are execution
 * work: the coordinator dispatches them like any other task instead of running them
 * itself, so the definitions only cost it context. Every other Agent keeps all three.
 */
const COORDINATOR_DROPPED_TOOL_NAMES = new Set([
    'website_deploy',
    'model_access_extension',
    'todowrite',
]);
const COORDINATOR_INLINE_CRON_TOOL_NAMES = new Set([
    'cron_create',
    'cron_read',
    'cron_update',
    'cron_delete',
]);
const COORDINATOR_CLI_KEPT_TOOL_NAMES = new Set([
    'mavis',
    'self_reminder',
    ...COORDINATOR_INLINE_CRON_TOOL_NAMES,
]);
export const DELEGATION_TOOL_NAMES = new Set(['task', 'task_append']);
const TASK_CONTROL_TOOL_NAMES = new Set(['task_query', 'task_output', 'task_stop']);
/** Coordination is a trusted built-in capability; any other owner reads as ordinary. */
function trustedCoordination(profile) {
    return profile?.trustedBuiltin === true ? profile.coordination : undefined;
}
export function isTrustedCoordinator(profile) {
    return isCoordinatorAgent(trustedCoordination(profile));
}
export function isAgentAuthorityToolAllowed(profile, name, source) {
    if (!isCoordinationToolAllowed(profile, name))
        return false;
    if (DELEGATION_TOOL_NAMES.has(name) ||
        (source !== 'builtin' && TASK_CONTROL_TOOL_NAMES.has(name))) {
        return isAuthoritativeMainProfile(profile);
    }
    return true;
}
/**
 * Task operations are an owner-only authority. These facts are frozen from the
 * trusted Agent profile while assembling the Turn, rather than from a mutable
 * display name or a product capability flag.
 */
function isAuthoritativeMainProfile(profile) {
    return ((profile?.surface === 'interactive' || profile?.surface === 'cli') &&
        profile.trustedBuiltin === true &&
        (profile.canonicalRole === 'mavis' || isTrustedCoordinator(profile)));
}
/** Tools a declared coordinator owns, and the ones its declaration takes away. */
function isCoordinationToolAllowed(profile, name) {
    const coordination = trustedCoordination(profile);
    const coordinator = isCoordinatorAgent(coordination);
    if (name === SEND_TO_USER_TOOL)
        return coordinator && coordination?.replyChannel === name;
    if (name === REMEMBER_TOOL)
        return coordinator && coordination?.memoryPipeline !== undefined;
    if (COORDINATOR_ONLY_TOOL_NAMES.has(name))
        return coordinator;
    if (COORDINATOR_DROPPED_TOOL_NAMES.has(name))
        return !coordinator;
    if (name === 'session_create')
        return !coordinator;
    const helperAgents = coordination?.helperAgents;
    // Declared helpers run once inside the turn (restrictTaskToHelperAgents), so there is no
    // running child to append to; an empty list means delegating only through its own tools.
    if (name === 'task_append')
        return helperAgents === undefined;
    return !(name === 'task' && helperAgents?.length === 0);
}
/**
 * The CLI ceiling turns `mavis` off. A coordinator still needs `mavis` for space,
 * context and project lookups, and sees its cron, self_reminder and miniapp tools so a
 * call returns the structured "not available in CLI" refusal instead of vanishing.
 */
export function keepsCoordinatorCliTool(profile, name) {
    return isTrustedCoordinator(profile) && COORDINATOR_CLI_KEPT_TOOL_NAMES.has(name);
}
/**
 * A coordinator lists its cron tools inline, sees its own mavis commands and
 * cron `space` (coordinatorToolDefinition), keeps `task` to its helper Agents,
 * and drops operator tools when its declaration blocks them.
 */
export function shapeCoordinatorTools(profile, inventory) {
    const coordination = trustedCoordination(profile);
    const coordinator = isCoordinatorAgent(coordination);
    const blocksOperatorTools = coordination?.blockOperatorTools === true;
    const helperAgents = coordination?.helperAgents;
    const inlineCoordinatorCron = (tool) => {
        if (!coordinator)
            return tool;
        const def = coordinatorToolDefinition(tool.def);
        if (COORDINATOR_INLINE_CRON_TOOL_NAMES.has(def.name))
            return { ...tool, def: { ...def, loading: 'default' } };
        return def === tool.def ? tool : { ...tool, def };
    };
    const shapeCoordinatorTool = (tool) => helperAgents && tool.def.name === 'task'
        ? restrictTaskToHelperAgents(tool, helperAgents)
        : inlineCoordinatorCron(tool);
    return {
        nativeTools: inventory.nativeTools
            .filter((tool) => !(blocksOperatorTools && isOperatorTool(tool.def.name)))
            .map(shapeCoordinatorTool),
        mcpEntries: inventory.mcpEntries
            .filter((entry) => !(blocksOperatorTools && isOperatorTool(entry.tool.def.name)))
            .map((entry) => ({ ...entry, tool: shapeCoordinatorTool(entry.tool) })),
    };
}
/** Browser, phone and Computer Use operation belongs to a coordinator's delegated work. */
function isOperatorTool(name) {
    return (name === 'browser' ||
        name === 'mcp_browser' ||
        name === 'phone' ||
        name.startsWith('computer_') ||
        name.startsWith('mcp__iphone_use__') ||
        name.startsWith('mcp__android_use__'));
}
/**
 * A coordinator's sub-agents are its declared helpers; anything else becomes delegated work.
 * A helper runs in the foreground, so its result lands in the same turn: a review turn never
 * closes a task while a helper it started is still checking (spec 3.8).
 */
function restrictTaskToHelperAgents(tool, helperAgents) {
    const allowed = new Set(helperAgents);
    return {
        ...tool,
        impl: {
            execute: (ctx, input, signal, onUpdate) => {
                const agent = input.agent_name;
                if (typeof agent !== 'string' || !allowed.has(agent.trim().toLowerCase())) {
                    const text = helperAgentRefusal(helperAgents);
                    return Promise.resolve({
                        tool_name: 'task',
                        text,
                        content: [{ type: 'text', text }],
                        isError: true,
                    });
                }
                const foreground = { ...input, run_in_background: false };
                return tool.impl.execute(ctx, foreground, signal, onUpdate);
            },
        },
    };
}
function helperAgentRefusal(helperAgents) {
    return `子 Agent 只能用 ${helperAgents.join(' 或 ')}。要产出东西，请用 assignment_create 调度任务。`;
}
//# sourceMappingURL=local-turn-tool-authority.js.map