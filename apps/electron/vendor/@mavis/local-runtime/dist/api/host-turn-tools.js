import { buildLocalTurnToolSources } from './local-native-tools.js';
import { buildLocalTaskAdapter } from './local-task-runner.js';
import { buildLocalTaskAppendAdapter } from './local-task-append.js';
import { shouldEnableLocalTaskTool } from './local-task-tool-policy.js';
/**
 * Exposes only raw v1 product-domain tool sources to the hosted v2 runtime.
 * Final model gates, MCP disclosure and catalog ordering stay in AgentRuntime.
 */
export async function buildLocalTurnToolSourcesForHost(input) {
    const runtimeConfig = input.host.configGetter();
    const memoryAgentScopeEnabled = input.excludeAgentResources || input.session.sessionKind === 'task'
        ? false
        : input.memoryAgentScopeEnabled;
    const sources = await buildLocalTurnToolSources({
        skillRuntime: input.host.skillRuntime,
        toolsDisabled: input.toolsDisabled,
        dataDir: runtimeConfig.dataDir,
        configGetter: input.host.configGetter,
        workspaceRoot: input.session.workspaceDir,
        agentName: input.resourceAgentName,
        ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
        ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
        sessionId: input.session.sessionId,
        authContext: input.host.authContextGetter?.(),
        routingContextGetter: input.host.routingContextGetter,
        fetchImpl: input.host.fetchImpl,
        nativeWebSearchEnabled: ['electron', 'tui', 'cli'].includes(input.host.getRuntimeOwnerKind()),
        mcpService: input.host.mcpService,
        questionnaireContext: input.host.supportsInteraction('questionnaireReply')
            ? input.host.questionnaireServiceDeps()
            : undefined,
        emitBusEvent: (type, payload) => input.host.emitBusEvent(type, payload),
        enableTaskTool: shouldEnableLocalTaskTool(input.session),
        bashAdapter: input.host.backgroundTasks.buildBashAdapter(input.session, input.sandboxOperationsFactory),
        sandboxOperationsFactory: input.sandboxOperationsFactory,
        taskAdapter: buildLocalTaskAdapter(input.host, input.session),
        taskAppendAdapter: buildLocalTaskAppendAdapter(input.host),
        taskControlAdapter: input.host.backgroundTaskService,
        memoryFacade: input.host.memoryFacade,
        memoryEnabled: input.memoryEnabled ?? runtimeConfig.memory?.enabled !== false,
        memoryReadEnabled: input.memoryReadEnabled,
        memoryWriteEnabled: input.memoryWriteEnabled,
        ...(memoryAgentScopeEnabled === undefined ? {} : { memoryAgentScopeEnabled }),
        ...(input.memoryReadAgentNames === undefined
            ? {}
            : { memoryReadAgentNames: input.memoryReadAgentNames }),
        ...(input.allowedSkillNames === undefined
            ? {}
            : { allowedSkillNames: input.allowedSkillNames }),
        ...(input.allowedExtensionSkillNames === undefined
            ? {}
            : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
        metrics: input.host.metrics,
        mavisAgentAdapter: input.mavisAgentAdapter,
        ...(input.cronEnabled !== false && input.mavisCronAdapter
            ? { mavisCronAdapter: input.mavisCronAdapter }
            : {}),
        mavisSessionAdapter: input.mavisSessionAdapter,
        ...(input.miniappAvailable === true ? { miniappAvailable: true } : {}),
        ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        computerUseActive: input.computerUseActive === true,
        ...(input.builtinCapabilities ? { builtinCapabilities: input.builtinCapabilities } : {}),
        ...(input.disabledBuiltinSkillNames
            ? { disabledBuiltinSkillNames: input.disabledBuiltinSkillNames }
            : {}),
        ...(input.resumeCodexAvailable === true ? { resumeCodexAvailable: true } : {}),
        ...(input.codeReviewAdapter ? { codeReviewAdapter: input.codeReviewAdapter } : {}),
    });
    try {
        // A READY index is not proof that even the raw tool catalog contains search.
        // AgentRuntime still owns the final model gates after this boundary.
        input.host.metricsClient?.counter('workspace_indexing_tool_catalog_total', 1, {
            os: process.platform === 'darwin' ||
                process.platform === 'linux' ||
                process.platform === 'win32'
                ? process.platform
                : 'other',
            outcome: sources.nativeTools.some((tool) => tool.def.name === 'workspace_semantic_search')
                ? 'present'
                : 'absent',
        });
    }
    catch {
        // Observation must not prevent tool assembly.
    }
    return sources;
}
//# sourceMappingURL=host-turn-tools.js.map