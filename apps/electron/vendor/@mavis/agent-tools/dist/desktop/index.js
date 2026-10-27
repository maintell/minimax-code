import { buildLocalCronTools } from './local-cron-tools.js';
import { buildLocalSessionCreateTool } from './local-session-create-tool.js';
import { toRuntimeTool } from '@mavis/agent-core/tools';
import { LocalAskUserTool } from './local-ask-user.js';
import { LocalFeatureEnableTool } from './local-feature-enable.js';
import { LocalBashTool, LocalEditTool, LocalReadTool, LocalWriteTool } from './local-pi-tools.js';
import { LocalGlobTool } from './local-glob.js';
import { LocalGrepTool } from './local-grep.js';
import { LocalSkillTool } from './local-skill.js';
import { LocalMavisTool } from './local-mavis.js';
import { LocalMemoryTool } from './local-memory.js';
import { LocalCodeReviewTool } from './local-code-review.js';
import { LocalTaskOutputTool, LocalTaskQueryTool, LocalTaskStopTool, } from './local-task-control.js';
import { LocalTaskTool } from './local-task.js';
import { LocalTaskAppendTool } from './local-task-append.js';
import { LocalTodoWriteTool } from './local-todowrite.js';
import { LocalWebFetchTool } from './local-webfetch.js';
import { LocalWebSearchTool } from './local-web-search.js';
import { LocalWebsiteDeployTool } from './local-website-deploy.js';
import { LocalWorkspaceSemanticSearchTool } from './local-workspace-semantic-search.js';
export * from './builtin-defs.js';
export * from './canonical-tool-policy.js';
export * from './local-ask-user.js';
export * from './local-feature-enable.js';
export * from './local-browser.js';
export * from './local-pi-tools.js';
export * from './local-bash-result.js';
export * from './local-bash-timing.js';
export * from './local-bash-input.js';
export * from './local-bash-contract.js';
export * from './permission-execution.js';
export { executeLocalHostTrashIfRequested } from './host-trash-executor.js';
export * from './local-glob.js';
export * from './local-grep.js';
export * from './local-rg-runner.js';
export * from './local-skill.js';
export * from './local-mavis.js';
export * from './local-mavis-commands.js';
export * from './local-mavis-cron-adapter.js';
export * from './local-memory.js';
export * from './local-code-review.js';
export * from './local-task-control.js';
export * from './local-task.js';
export * from './local-task-append.js';
export * from './task-verification.js';
export * from './local-todowrite.js';
export * from './local-webfetch.js';
export * from './local-web-search.js';
export * from './local-website-deploy.js';
export * from './local-workspace-semantic-search.js';
export * from './matrix-client.js';
export * from './managed-routing.js';
export * from './matrix-env.js';
export * from './matrix-media-client.js';
export * from './matrix-mcp-server.js';
export * from './matrix-tools.js';
export * from './types.js';
export * from './subagent-roles.js';
export * from '../shared/web-search.js';
export { DEFAULT_BROAD_FILE_EXCLUDES, DEFAULT_SCAN_DIRECTORY_NAMES, isDefaultBroadFileExcluded, isDefaultScanNoisePath, } from '../shared/rg-scan-policy.js';
export { isSensitiveSearchPath } from './local-sensitive.js';
export function buildLocalToolRegistry(deps) {
    const tools = [
        toRuntimeTool(new LocalReadTool(deps.workspaceRoot)),
        toRuntimeTool(new LocalWriteTool(deps.workspaceRoot)),
        toRuntimeTool(new LocalEditTool(deps.workspaceRoot)),
        toRuntimeTool(new LocalBashTool(deps.workspaceRoot, deps.bashAdapter, deps.bashEnvPolicy, deps.hostTrashRuntime, deps.sandboxOperationsFactory)),
        toRuntimeTool(new LocalGrepTool(deps.workspaceRoot)),
        toRuntimeTool(new LocalGlobTool(deps.workspaceRoot)),
        toRuntimeTool(new LocalTodoWriteTool(deps.todoEventSink)),
    ];
    if (deps.skillReader) {
        tools.push(toRuntimeTool(new LocalSkillTool(deps.skillReader)));
    }
    if (deps.memoryAdapter) {
        tools.push(toRuntimeTool(new LocalMemoryTool(deps.memoryAdapter)));
    }
    if (deps.codeReviewAdapter) {
        tools.push(toRuntimeTool(new LocalCodeReviewTool(deps.codeReviewAdapter)));
    }
    if (deps.mavisAgentAdapter) {
        tools.push(toRuntimeTool(new LocalMavisTool(deps.mavisAgentAdapter, deps.mavisCronAdapter, deps.mavisSessionAdapter, deps.mavisMcpAdapter)));
    }
    if (deps.mavisAgentAdapter && deps.mavisSessionAdapter) {
        tools.push(buildLocalSessionCreateTool({
            agentAdapter: deps.mavisAgentAdapter,
            sessionAdapter: deps.mavisSessionAdapter,
        }));
    }
    if (deps.mavisAgentAdapter && deps.mavisCronAdapter) {
        tools.push(...buildLocalCronTools({
            agentAdapter: deps.mavisAgentAdapter,
            cronAdapter: deps.mavisCronAdapter,
            sessionAdapter: deps.mavisSessionAdapter,
            workspaceRoot: deps.workspaceRoot,
        }));
    }
    if (deps.askUserAdapter) {
        tools.push(toRuntimeTool(new LocalAskUserTool(deps.askUserAdapter)));
        tools.push(toRuntimeTool(new LocalFeatureEnableTool(deps.askUserAdapter)));
    }
    if (deps.webFetchAdapter) {
        tools.push(toRuntimeTool(new LocalWebFetchTool(deps.webFetchAdapter)));
    }
    if (deps.webSearchAdapter) {
        tools.push(toRuntimeTool(new LocalWebSearchTool(deps.webSearchAdapter)));
    }
    if (deps.taskAdapter) {
        tools.push(toRuntimeTool(new LocalTaskTool(deps.taskAdapter)));
    }
    if (deps.taskAppendAdapter) {
        tools.push(toRuntimeTool(new LocalTaskAppendTool(deps.taskAppendAdapter)));
    }
    if (deps.taskControlAdapter) {
        tools.push(toRuntimeTool(new LocalTaskQueryTool(deps.taskControlAdapter)), toRuntimeTool(new LocalTaskOutputTool(deps.taskControlAdapter)), toRuntimeTool(new LocalTaskStopTool(deps.taskControlAdapter)));
    }
    if (deps.websiteDeployAdapter) {
        tools.push(toRuntimeTool(new LocalWebsiteDeployTool(deps.websiteDeployAdapter, deps.workspaceRoot)));
    }
    if (deps.workspaceSemanticSearchAdapter) {
        tools.push(toRuntimeTool(new LocalWorkspaceSemanticSearchTool(deps.workspaceSemanticSearchAdapter)));
    }
    const map = new Map();
    for (const tool of tools) {
        if (map.has(tool.def.name)) {
            throw new Error(`buildLocalToolRegistry: duplicate tool name '${tool.def.name}'`);
        }
        map.set(tool.def.name, tool);
    }
    return map;
}
export { CloudSessionReader, CloudSessionReadError, } from './cloud-session-reader.js';
export { buildLocalCronTools } from './local-cron-tools.js';
export { CRON_TOOL_NAMES, MAVIS_CAPABILITY_TOOL_NAMES, LocalSelfReminderToolDef, LocalSelfReminderToolDef as SelfReminderToolDef, cronToolDefinitions, selfReminderIntervalMinutes, } from '../cron/tool-defs.js';
export { DESKTOP_BASH_PREVIEW_BYTES, DESKTOP_BASH_MAX_OUTPUT_BYTES, DESKTOP_BASH_MAX_PENDING_OUTPUT_BYTES, } from './output-limit.js';
export * from './background-task-runtime.js';
//# sourceMappingURL=index.js.map