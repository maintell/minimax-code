import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { coordinatorToolDefinition } from '@mavis/agent-tools/tool-policy';
import { BUNNY_SPACE_TOOL_NAMES, coordinatorHiddenToolNames, } from '@mavis/agent-tools/namespaced-tools';
const SEND_TO_USER_TOOL = 'send_to_user';
const REMEMBER_TOOL = 'remember';
const COORDINATOR_ONLY_TOOL_NAMES = new Set([
    'assignment_create',
    'assignment_send',
    'assignment_cancel',
    'assignment_stop',
    'assignment_summary',
    // Reading a stored verdict is Bunny's alone, like every other assignment tool: the
    // definition says so, requireBunny refuses the call for anyone else, and an ordinary
    // Agent that could see it would only spend a step on a refusal. Left out of this set
    // it fell through to the allow at the end of isCoordinationToolAllowed and reached
    // every mavis session's tool list.
    'assignment_claim_verdict',
    REMEMBER_TOOL,
    SEND_TO_USER_TOOL,
    'working_state',
    ...BUNNY_SPACE_TOOL_NAMES,
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
/**
 * Tools a coordinator never sees, read from the namespace registry's
 * coordinator allowlist: every namespaced tool outside it, so a tool added to
 * any namespace later stays hidden until the allowlist names it. Offering one
 * costs the model a round for nothing — the Agent roster, MCP servers and a
 * conversation's own settings are the user's actions, dispatching work is its
 * assignment tools' job, and the executor refuses every such call anyway. The
 * Skill gate reads the same rule, so the two never disagree.
 */
const COORDINATOR_HIDDEN_TOOL_NAMES = new Set(coordinatorHiddenToolNames());
const COORDINATOR_CLI_KEPT_TOOL_NAMES = new Set([
    ...BUNNY_SPACE_TOOL_NAMES,
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
/**
 * `delegationAuthority` is the Task authority a Host without a Desktop Agent
 * profile (cloud) declares through HostToolCatalogRules; when set it replaces
 * the trusted main-profile check. Coordination rules still apply.
 */
export function isAgentAuthorityToolAllowed(profile, name, source, delegationAuthority) {
    if (!isCoordinationToolAllowed(profile, name))
        return false;
    if (DELEGATION_TOOL_NAMES.has(name) ||
        (source !== 'builtin' && TASK_CONTROL_TOOL_NAMES.has(name))) {
        return delegationAuthority ?? isAuthoritativeMainProfile(profile);
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
    const byName = coordinatorNameRule(name, coordinator);
    if (byName !== undefined)
        return byName;
    const helperAgents = coordination?.helperAgents;
    // Declared helpers run once inside the turn (restrictTaskToHelperAgents), so there is no
    // running child to append to; an empty list means delegating only through its own tools.
    if (name === 'task_append')
        return helperAgents === undefined;
    return !(name === 'task' && helperAgents?.length === 0);
}
/**
 * The names the coordinator flag alone decides, in the order they were checked
 * before; undefined for every other name, which the helper-Agent rules decide.
 */
function coordinatorNameRule(name, coordinator) {
    if (COORDINATOR_ONLY_TOOL_NAMES.has(name))
        return coordinator;
    if (COORDINATOR_HIDDEN_TOOL_NAMES.has(name))
        return !coordinator;
    if (COORDINATOR_DROPPED_TOOL_NAMES.has(name))
        return !coordinator;
    if (name === 'session_create')
        return !coordinator;
    return undefined;
}
/**
 * The CLI ceiling turns the desktop command tools off. A coordinator still needs
 * its own space, context and task model tools, and sees its cron, self_reminder
 * and miniapp tools so a call returns the structured "not available in CLI"
 * refusal instead of vanishing.
 */
export function keepsCoordinatorCliTool(profile, name) {
    return isTrustedCoordinator(profile) && COORDINATOR_CLI_KEPT_TOOL_NAMES.has(name);
}
/**
 * A coordinator lists its cron tools inline, sees cron `space`
 * (coordinatorToolDefinition), keeps `task` to its helper Agents, and drops
 * operator tools when its declaration blocks them. The composite `mavis` tool
 * is dropped from every catalog, the coordinator's included: its commands are
 * namespaced tools of their own (agent_*, session_*, mcp_server_*), each gated
 * behind its Skill, and the coordinator's own operations are top-level tools of
 * their own. The object stays in the inventory only as the execution identity
 * those calls run as.
 */
export function shapeCoordinatorTools(profile, inventory, 
/**
 * A Host that splits its own mavis command table (`catalog.ptcMavisTools`)
 * still lists the composite tool: that split registers every child against the
 * mavis call it stands for, so the object has to reach the catalog for the
 * split to happen at all. Every other catalog drops it, because its commands
 * are namespaced tools of their own.
 */
options = {}) {
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
    // `task` gets both: the coordinator definition rewrites its description, then
    // the helper restriction wraps the executor.
    const shapeCoordinatorTool = (tool) => {
        const shaped = inlineCoordinatorCron(tool);
        return helperAgents && tool.def.name === 'task'
            ? restrictTaskToHelperAgents(shaped, helperAgents)
            : shaped;
    };
    return {
        nativeTools: inventory.nativeTools
            .filter((tool) => !(blocksOperatorTools && isOperatorTool(tool.def.name)))
            .filter((tool) => options.hostMavisSplit === true || tool.def.name !== 'mavis')
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