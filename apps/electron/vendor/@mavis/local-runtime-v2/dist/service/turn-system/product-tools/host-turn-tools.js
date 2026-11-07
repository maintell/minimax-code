import { buildLocalTurnToolSources } from './local-native-tools.js';
import { buildLocalTaskAdapter, buildLocalTaskAppendAdapter, shouldEnableLocalTaskTool, } from '../../team/index.js';
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
        ...liveAuthSources(input.host),
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
        ...optionalResourceSelectors(input, memoryAgentScopeEnabled),
        metrics: input.host.metrics,
        mavisAgentAdapter: input.mavisAgentAdapter,
        ...(input.cronEnabled !== false && input.mavisCronAdapter
            ? { mavisCronAdapter: input.mavisCronAdapter }
            : {}),
        mavisSessionAdapter: input.mavisSessionAdapter,
        ...optionalToolCapabilities(input),
    });
    observeToolCatalog(input, sources);
    return sources;
}
/**
 * Passes the host getter itself, not its result: the host swaps in a new auth
 * object on every token refresh, so website_deploy must read it per request
 * instead of the Turn-start snapshot in `authContext`.
 */
function liveAuthSources(host) {
    return {
        ...(host.authContextGetter ? { authContextGetter: host.authContextGetter } : {}),
        ...(host.authContextInvalidator ? { authContextInvalidator: host.authContextInvalidator } : {}),
    };
}
function optionalResourceSelectors(input, memoryAgentScopeEnabled) {
    return {
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
    };
}
function optionalToolCapabilities(input) {
    return {
        ...(input.miniappAvailable === true ? { miniappAvailable: true } : {}),
        ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        computerUseActive: input.computerUseActive === true,
        ...(input.builtinCapabilities ? { builtinCapabilities: input.builtinCapabilities } : {}),
        ...(input.disabledBuiltinSkillNames
            ? { disabledBuiltinSkillNames: input.disabledBuiltinSkillNames }
            : {}),
        ...(input.resumeCodexAvailable === true ? { resumeCodexAvailable: true } : {}),
        ...(input.codeReviewAdapter ? { codeReviewAdapter: input.codeReviewAdapter } : {}),
    };
}
function observeToolCatalog(input, sources) {
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
}
//# sourceMappingURL=host-turn-tools.js.map