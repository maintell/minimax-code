import { buildLocalToolRegistry, LocalTodoWriteToolDef, } from '@mavis/agent-tools/desktop';
import { MatrixWebSearchToolDef } from '@mavis/agent-tools';
import { getConfig, resolveAgentCapabilities, } from '@mavis/config';
import { executeLocalMemoryTool } from '../../memory-system/index.js';
import { buildLocalHostTrashRuntime } from '../../permission/index.js';
import { resolveAgentBashEnvPolicy } from '../../../infra/process/ensure-rm-shim.js';
import { emitLocalTodoUpdatedEvent } from '../file-changes/todo-event.js';
import { initializeWebFetch } from '../../web-fetch/index.js';
import { createManagedLocalWebSearchClient } from '../../web-search/index.js';
import { LocalWebsiteDeployClient } from '../../website/index.js';
import { buildLocalAskUserAdapter } from '../../questionnaire/index.js';
import { withLocalMemoryPolicyGuidance } from './local-memory-policy-guidance.js';
import { filterLocalBuiltinCapabilityTools } from './local-native-tool-filter.js';
/** @internal Exported only for focused tests. */
export function buildLocalNativeRuntimeTools(input) {
    const capabilities = input.builtinCapabilities ?? resolveAgentCapabilities();
    const webFetchAdapter = input.webFetchAdapter ?? initializeWebFetch({ fetchImpl: input.fetchImpl });
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
            bashEnvPolicy: (plan) => resolveAgentBashEnvPolicy(input.dataDir, process.platform, plan?.nativeDelete ??
                (input.configGetter ?? getConfig)().permission?.nativeDelete === true),
            webFetchAdapter,
            webSearchAdapter,
            taskAdapter: input.taskAdapter,
            taskAppendAdapter: input.taskAppendAdapter,
            taskControlAdapter: input.taskControlAdapter,
            memoryAdapter: buildMemoryAdapter(input),
            mavisAgentAdapter: input.mavisAgentAdapter,
            mavisCronAdapter: input.mavisCronAdapter,
            mavisMcpAdapter: input.mavisMcpAdapter,
            mavisSessionAdapter: input.mavisSessionAdapter,
            workspaceSemanticSearchAdapter: input.workspaceSemanticSearchAdapter,
            websiteDeployAdapter: new LocalWebsiteDeployClient({
                ...(input.authContext ? { authContext: input.authContext } : {}),
                // The client lives for the whole Turn; a deploy late in a long Turn must use
                // the host's current token, not the one captured when tools were built.
                ...(input.authContextGetter ? { authContextGetter: input.authContextGetter } : {}),
                ...(input.authContextInvalidator
                    ? { authContextInvalidator: input.authContextInvalidator }
                    : {}),
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
            cuRuntimeAvailable: false,
        };
    }
    const cuRuntimeAvailable = false;
    const builtinCapabilities = input.builtinCapabilities ?? resolveAgentCapabilities();
    const nativeTools = buildTurnNativeTools(input, builtinCapabilities);
    const mcpEntries = await buildTurnMcpEntries(input, builtinCapabilities);
    return {
        nativeTools: nativeTools,
        mcpEntries,
        cuRuntimeAvailable,
    };
}
function buildTurnNativeTools(input, builtinCapabilities) {
    const enableTaskControlTools = input.enableTaskControlTools ?? !!input.taskControlAdapter;
    // `task` and `task_append` are the same delegation entry point: a surface
    // that may not start a task may not continue one either.
    const delegationEntryPointsEnabled = input.enableTaskTool !== false && builtinCapabilities.features.delegation;
    const nativeTools = buildLocalNativeRuntimeTools({
        skillRuntime: input.skillRuntime,
        dataDir: input.dataDir,
        configGetter: input.configGetter,
        workspaceRoot: input.workspaceRoot,
        agentName: input.agentName,
        ...nativeAgentScope(input),
        eventWriter: input.eventWriter,
        askUserAdapter: buildLocalAskUserAdapter(input.questionnaireContext),
        bashAdapter: input.bashAdapter,
        sandboxOperationsFactory: input.sandboxOperationsFactory,
        authContext: input.authContext,
        authContextGetter: input.authContextGetter,
        authContextInvalidator: input.authContextInvalidator,
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
    return gatedNativeTools;
}
async function buildTurnMcpEntries(input, builtinCapabilities) {
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
    return selectedMcpEntries;
}
function nativeAgentScope(input) {
    return {
        ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
        ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
    };
}
function buildMemoryAdapter(input) {
    const facade = input.memoryFacade;
    if (!facade ||
        input.memoryEnabled === false ||
        input.excludeAgentResources ||
        input.memoryAgentScopeEnabled !== true ||
        (input.memoryReadEnabled === false && input.memoryWriteEnabled === false))
        return undefined;
    return {
        execute: (ctx, toolInput) => executeLocalMemoryTool({
            facade,
            ctx,
            input: toolInput,
            emitBusEvent: input.emitBusEvent,
            metrics: input.metrics,
            readAgentNames: input.memoryReadAgentNames,
            access: {
                readEnabled: input.memoryReadEnabled !== false,
                writeEnabled: input.memoryWriteEnabled !== false,
                agentScopeEnabled: input.memoryAgentScopeEnabled,
            },
        }),
    };
}
function requireSkillRuntime(runtime) {
    if (!runtime)
        throw new Error('Skill runtime is not configured');
    return runtime;
}
//# sourceMappingURL=local-native-tools.js.map