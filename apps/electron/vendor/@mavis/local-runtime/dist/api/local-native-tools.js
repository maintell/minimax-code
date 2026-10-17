import { buildLocalToolRegistry, LocalTodoWriteToolDef, } from '@mavis/agent-tools/desktop';
import { MatrixWebSearchToolDef } from '@mavis/agent-tools';
import { resolveAgentCapabilities, } from '@mavis/config';
import { executeLocalMemoryTool } from '../memory/local-memory-tool.js';
import { buildLocalHostTrashRuntime } from '../permissions/host-trash-runtime.js';
import { resolveAgentBashEnvPolicy } from '../infra/ensure-rm-shim.js';
import { emitLocalTodoUpdatedEvent } from '../turns/todo-event.js';
import { LocalWebFetchClient } from '../web-fetch/index.js';
import { createManagedLocalWebSearchClient } from '../web-search/index.js';
import { LocalWebsiteDeployClient } from '../website-deploy/index.js';
import { buildLocalAskUserAdapter } from './local-ask-user-adapter.js';
import { withLocalMemoryPolicyGuidance } from './local-memory-policy-guidance.js';
import { filterLocalBuiltinCapabilityTools } from './local-native-tool-filter.js';
export function buildLocalNativeRuntimeTools(input) {
    const capabilities = input.builtinCapabilities ?? resolveAgentCapabilities();
    const webFetchAdapter = input.webFetchAdapter ?? new LocalWebFetchClient({ fetchImpl: input.fetchImpl });
    const webSearchAdapter = input.webSearchEnabled === true
        ? (input.webSearchAdapter ?? createManagedLocalWebSearchClient(input))
        : undefined;
    const nativeTools = [
        ...buildLocalToolRegistry({
            workspaceRoot: input.workspaceRoot,
            skillReader: {
                readSkill: (name, agentName) => requireSkillRuntime(input.skillRuntime).readNativeSkill({
                    name,
                    policy: capabilities,
                    gates: {
                        computerUseActive: input.computerUseActive === true,
                        miniappAvailable: input.miniappAvailable === true,
                        disabledSkillNames: input.disabledBuiltinSkillNames,
                        resumeCodexAvailable: input.resumeCodexAvailable === true,
                    },
                    scope: {
                        agentName: agentName ?? input.agentName,
                        ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
                        ...(input.expectedAgentInstanceId
                            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
                            : {}),
                        ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
                        workspaceDir: input.workspaceRoot,
                        allowedSkillNames: input.allowedSkillNames,
                        allowedExtensionSkillNames: input.allowedExtensionSkillNames,
                    },
                    desktopSkills: input.desktopCapabilities?.skills,
                }),
            },
            todoEventSink: {
                emitTodoUpdated: (ctx, todos, signal) => emitLocalTodoUpdatedEvent({
                    ctx,
                    todos,
                    signal,
                    emitBusEvent: input.emitBusEvent,
                }),
            },
            askUserAdapter: input.askUserAdapter,
            bashAdapter: input.bashAdapter,
            sandboxOperationsFactory: input.sandboxOperationsFactory,
            hostTrashRuntime: buildLocalHostTrashRuntime(input),
            bashEnvPolicy: resolveAgentBashEnvPolicy(input.dataDir),
            webFetchAdapter,
            webSearchAdapter,
            taskAdapter: input.taskAdapter,
            taskAppendAdapter: input.taskAppendAdapter,
            taskControlAdapter: input.taskControlAdapter,
            memoryAdapter: input.memoryFacade &&
                input.memoryEnabled !== false &&
                !input.excludeAgentResources &&
                input.memoryAgentScopeEnabled === true &&
                (input.memoryReadEnabled !== false || input.memoryWriteEnabled !== false)
                ? {
                    execute: (ctx, toolInput) => executeLocalMemoryTool(input.memoryFacade, ctx, toolInput, input.emitBusEvent, input.metrics, input.memoryReadAgentNames, {
                        readEnabled: input.memoryReadEnabled !== false,
                        writeEnabled: input.memoryWriteEnabled !== false,
                        agentScopeEnabled: input.memoryAgentScopeEnabled,
                    }),
                }
                : undefined,
            mavisAgentAdapter: input.mavisAgentAdapter,
            mavisCronAdapter: input.mavisCronAdapter,
            mavisMcpAdapter: input.mavisMcpAdapter,
            mavisSessionAdapter: input.mavisSessionAdapter,
            workspaceSemanticSearchAdapter: input.workspaceSemanticSearchAdapter,
            websiteDeployAdapter: new LocalWebsiteDeployClient({
                ...(input.authContext ? { authContext: input.authContext } : {}),
                ...(input.dataDir ? { dataDir: input.dataDir } : {}),
                ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
                routingContextGetter: input.routingContextGetter,
            }),
            codeReviewAdapter: input.codeReviewAdapter,
        }).values(),
    ];
    return filterLocalBuiltinCapabilityTools(nativeTools.map((tool) => withLocalMemoryPolicyGuidance(tool, {
        readEnabled: input.memoryReadEnabled !== false,
        writeEnabled: input.memoryWriteEnabled !== false,
    })), capabilities);
}
/**
 * Returns still-unmigrated product-domain tool sources before the v2
 * AgentRuntime applies model gates, MCP disclosure and final catalog ordering.
 */
export async function buildLocalTurnToolSources(input) {
    if (input.toolsDisabled) {
        return {
            nativeTools: [],
            mcpEntries: [],
            threadGoalTools: [],
            cuRuntimeAvailable: false,
        };
    }
    const cuRuntimeAvailable = false;
    const builtinCapabilities = input.builtinCapabilities ?? resolveAgentCapabilities();
    const enableTaskControlTools = input.enableTaskControlTools ?? !!input.taskControlAdapter;
    // `task` and `task_append` are the same delegation entry point: a surface
    // that may not start a task may not continue one either.
    const delegationEntryPointsEnabled = input.enableTaskTool !== false && builtinCapabilities.features.delegation;
    const nativeTools = buildLocalNativeRuntimeTools({
        skillRuntime: input.skillRuntime,
        dataDir: input.dataDir,
        workspaceRoot: input.workspaceRoot,
        agentName: input.agentName,
        ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
        ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
        eventWriter: input.eventWriter,
        askUserAdapter: buildLocalAskUserAdapter(input.questionnaireContext),
        bashAdapter: input.bashAdapter,
        sandboxOperationsFactory: input.sandboxOperationsFactory,
        authContext: input.authContext,
        routingContextGetter: input.routingContextGetter,
        fetchImpl: input.fetchImpl,
        webSearchEnabled: input.nativeWebSearchEnabled === true,
        taskAdapter: delegationEntryPointsEnabled ? input.taskAdapter : undefined,
        taskAppendAdapter: delegationEntryPointsEnabled ? input.taskAppendAdapter : undefined,
        taskControlAdapter: enableTaskControlTools ? input.taskControlAdapter : undefined,
        memoryFacade: input.memoryFacade,
        mavisAgentAdapter: input.mavisAgentAdapter,
        mavisCronAdapter: input.mavisCronAdapter,
        mavisMcpAdapter: input.mcpService.createMavisAdapter(input.emitBusEvent),
        mavisSessionAdapter: input.mavisSessionAdapter,
        codeReviewAdapter: input.codeReviewAdapter,
        workspaceSemanticSearchAdapter: input.workspaceSemanticSearchAdapter,
        emitBusEvent: input.emitBusEvent,
        metrics: input.metrics,
        computerUseActive: input.computerUseActive === true,
        ...(input.miniappAvailable === true ? { miniappAvailable: true } : {}),
        desktopCapabilities: input.desktopCapabilities,
        builtinCapabilities,
        memoryEnabled: input.memoryEnabled,
        memoryReadEnabled: input.memoryReadEnabled,
        memoryWriteEnabled: input.memoryWriteEnabled,
        memoryAgentScopeEnabled: input.memoryAgentScopeEnabled,
        memoryReadAgentNames: input.memoryReadAgentNames,
        ...(input.allowedSkillNames === undefined
            ? {}
            : { allowedSkillNames: input.allowedSkillNames }),
        ...(input.allowedExtensionSkillNames === undefined
            ? {}
            : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
        disabledBuiltinSkillNames: input.disabledBuiltinSkillNames,
        resumeCodexAvailable: input.resumeCodexAvailable,
    });
    const gatedNativeTools = input.enableTodoWriteTool === false
        ? nativeTools.filter((tool) => tool.def.name !== LocalTodoWriteToolDef.name)
        : nativeTools;
    const allEntries = await input.mcpService.listToolEntriesForTurn({
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        ...(input.authContext ? { authContext: input.authContext } : {}),
        routingContextGetter: input.routingContextGetter,
        emitBusEvent: input.emitBusEvent,
    });
    const selectedBuiltinMcpEntries = builtinCapabilities.builtinTools === undefined
        ? allEntries
        : allEntries.filter((entry) => entry.source !== 'builtin-matrix' ||
            entry.tool.def.name === MatrixWebSearchToolDef.name ||
            builtinCapabilities.builtinTools.includes(entry.tool.def.name));
    const selectedMcpEntries = builtinCapabilities.features.webSearch
        ? selectedBuiltinMcpEntries
        : selectedBuiltinMcpEntries.filter((entry) => !(entry.source === 'builtin-matrix' && entry.tool.def.name === MatrixWebSearchToolDef.name));
    const mcpEntries = selectedMcpEntries;
    const threadGoalTools = (await input.threadGoal.runtimeToolsFor(false, input.sessionId));
    return {
        nativeTools: gatedNativeTools,
        mcpEntries,
        threadGoalTools,
        cuRuntimeAvailable,
    };
}
function requireSkillRuntime(runtime) {
    if (!runtime)
        throw new Error('Skill runtime is not configured');
    return runtime;
}
//# sourceMappingURL=local-native-tools.js.map