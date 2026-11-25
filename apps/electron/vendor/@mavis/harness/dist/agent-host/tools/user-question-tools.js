import { toRuntimeTool } from '@mavis/agent-core/tools';
import { LocalAskUserTool, LocalFeatureEnableTool, } from '@mavis/agent-tools/ask-user';
/**
 * Names that come before the question tools in the Desktop native registry
 * (`buildLocalToolRegistry`), and the names that come after them. Host
 * wrappers add other native tools (Browser after web_fetch/web_search or at
 * the front, Computer Use at the end), so the slot is found by these names
 * rather than by index. A contract test pins both lists to the registry.
 */
const REGISTRY_PREDECESSORS = new Set([
    'read',
    'write',
    'edit',
    'bash',
    'grep',
    'glob',
    'todowrite',
    'skill',
    'memory',
    'code_review',
    'mavis',
    'assignment_create',
    'assignment_send',
    'assignment_summary',
    'assignment_cancel',
    'assignment_stop',
    'send_to_user',
    'session_create',
    'self_reminder',
    'cron_create',
    'cron_read',
    'cron_update',
    'cron_delete',
]);
const REGISTRY_SUCCESSORS = new Set([
    'web_fetch',
    'web_search',
    'task',
    'task_append',
    'task_query',
    'task_output',
    'task_stop',
    'website_deploy',
    'workspace_semantic_search',
]);
/**
 * Replaces `questions` with ask_user and request_feature_enable (ask_user only
 * when the Host sets `featureEnable: false`) in the native tools, in the
 * Desktop registry slot: after the last predecessor, else before the first
 * successor, else at the end. Without `questions` the sources pass through
 * unchanged. Apply it once per resolved source set.
 */
export function withUserQuestionTools(sources) {
    const { questions, ...rest } = sources;
    if (!questions)
        return rest;
    const adapter = userQuestionAdapter(questions);
    const questionTools = [
        askUserTool(adapter, questions.askUserDescription),
        ...(questions.featureEnable === false
            ? []
            : [toRuntimeTool(new LocalFeatureEnableTool(adapter))]),
    ];
    const tools = sources.nativeTools;
    const slot = questionToolSlot(tools);
    return {
        ...rest,
        nativeTools: [...tools.slice(0, slot), ...questionTools, ...tools.slice(slot)],
    };
}
/** `toRuntimeTool` returns the shared module def, so a Host description goes on a copy. */
function askUserTool(adapter, description) {
    const tool = toRuntimeTool(new LocalAskUserTool(adapter));
    return description === undefined ? tool : { ...tool, def: { ...tool.def, description } };
}
function questionToolSlot(tools) {
    const lastPredecessor = tools
        .map((tool) => REGISTRY_PREDECESSORS.has(tool.def.name))
        .lastIndexOf(true);
    if (lastPredecessor >= 0)
        return lastPredecessor + 1;
    const firstSuccessor = tools.findIndex((tool) => REGISTRY_SUCCESSORS.has(tool.def.name));
    return firstSuccessor >= 0 ? firstSuccessor : tools.length;
}
/**
 * begin, then for a sync question await. `await` runs even when the signal
 * has already aborted, so the Host's wait rejects with its Stop message and
 * releases what `begin` reserved.
 */
function userQuestionAdapter(host) {
    return {
        begin: async (ctx, input, signal) => {
            const result = await host.begin(ctx, input, signal);
            if (!('responseMode' in result) || result.responseMode !== 'sync' || !host.await) {
                return result;
            }
            return { ...result, outcome: await host.await(result, signal) };
        },
    };
}
//# sourceMappingURL=user-question-tools.js.map