import { createAgentRuntime } from '@mavis/agent-runtime';
import { getLocalBashEnvironment } from '@mavis/agent-tools';
import { buildLocalTurnToolCatalog, } from './assembly/local-turn-tool-catalog.js';
import { createLocalTurnToolCatalogInput, } from './assembly/local-turn-tool-catalog-source.js';
import { NativeLocalTurnExecutionPreparationSource } from './assembly/local-turn-execution-preparation.js';
import { LocalTurnInputPreparer, } from './assembly/local-turn-input-preparation.js';
import {} from './execution/executor.js';
import { LocalAgentConfigBuilder, LocalAgentPreparationService, } from './preparation/index.js';
import { observeAgentTurnSetupStage } from './preparation/turn-preflight.js';
import { createAgentHostProductionDependencies, } from './production-dependencies.js';
import { LocalAgentTurnRunner, LocalTurnPermissionGate, } from './runner/index.js';
/**
 * Composes the v2-owned conversation core without attaching it to
 * `services.ts`, Dispatcher, HTTP, or v1 compatibility.
 */
export async function createNativeAgentHostProductionDependencies(options) {
    const toolCatalog = createToolCatalogSource(options.toolCatalog);
    const normalRuntime = await createAgentRuntime({
        base: configuredNormalExtensions(options.normalExtensions),
    });
    const normal = {
        async assembleModelContext(context, desktopCapabilities) {
            const seed = await toolCatalog.build(createLocalTurnToolCatalogInput(context, desktopCapabilities));
            return normalRuntime.assembleModelContext(context, seed);
        },
        async assembleTurn(context, desktopCapabilities) {
            const logContext = { sessionId: context.sessionId, turnId: context.turnId };
            if (context.turnIntent?.kind === 'goal-completion-summary') {
                const assembly = await observeAgentTurnSetupStage(options.runner.logger, logContext, 'agent_runtime_assembly', () => normalRuntime.assembleTurn(context, {
                    tools: [],
                    userPromptPrefix: '',
                }));
                // Include extension reminders, but expose no native, plugin, or extension tools.
                // The host's Goal budget policy is a second execution-time fence.
                return { ...assembly, tools: [], diagnostic: { ...assembly.diagnostic, toolCount: 0 } };
            }
            const seed = await observeAgentTurnSetupStage(options.runner.logger, logContext, 'tool_catalog_build', () => toolCatalog.build(createLocalTurnToolCatalogInput(context, desktopCapabilities)));
            return observeAgentTurnSetupStage(options.runner.logger, logContext, 'agent_runtime_assembly', () => normalRuntime.assembleTurn(context, seed));
        },
    };
    const runtime = new LocalAgentTurnRunner(options.runner);
    const executionPreparation = new NativeLocalTurnExecutionPreparationSource(new LocalTurnInputPreparer({
        ...options.inputPreparation,
        persistComputerUseSelection: options.turnRuntimeFacts?.persistComputerUseSelection,
    }), new LocalTurnPermissionGate(createPermissionGateOptions(options)));
    const dependencies = createNativeAgentHostDependencies(options, normal, runtime, executionPreparation);
    return {
        ...dependencies,
        backgroundTaskReads: {
            confirm: async (input) => await options.inputPreparation.reminders.confirmBackgroundTaskReads(input),
        },
        lifecycle: createAgentHostRuntimeLifecycle(normalRuntime, options.permission.mutations),
    };
}
function createNativeAgentHostDependencies(options, normal, runtime, executionPreparation) {
    const permissionMutations = options.permission.mutations;
    return createAgentHostProductionDependencies({
        sessions: options.sessions,
        ...(options.planDocuments ? { planDocuments: options.planDocuments } : {}),
        agentRuntimes: { normal },
        agents: options.agents,
        promptSnapshots: options.promptSnapshots,
        ...(options.internalTurnPromptReads
            ? { internalTurnPromptReads: options.internalTurnPromptReads }
            : {}),
        ...withTurnRuntimeFacts(options.turnRuntimeFacts),
        preparation: options.preparation,
        compaction: options.compaction,
        turnControl: options.turnControl,
        ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
        ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
        canonicalHistory: options.canonicalHistory,
        ...(options.runner.logger ? { logger: options.runner.logger } : {}),
        ...(options.usage ? { usage: options.usage } : {}),
        events: options.events,
        executor: {
            ...options.executor,
            runtime,
            executionPreparation,
            ...(permissionMutations
                ? {
                    clearPluginHookSessionPermissions: (sessionId) => permissionMutations.clearSession(sessionId),
                }
                : {}),
            ...(options.toolPolicyGuard ? { toolPolicyGuard: options.toolPolicyGuard } : {}),
        },
        ...(options.isRuntimeErrorRetryable
            ? { isRuntimeErrorRetryable: options.isRuntimeErrorRetryable }
            : {}),
    });
}
function createPermissionGateOptions(options) {
    const logger = options.permission.logger ?? options.runner.logger;
    return {
        ...options.permission,
        ...(logger ? { logger } : {}),
        enforceBuiltinTools: options.executor.cliProductPolicy === true && options.executor.tuiProductPolicy !== true,
    };
}
/** Builds the shared native config/model preparation used by AgentHost and title calls. */
export function createNativeLocalAgentPreparation(options) {
    return new LocalAgentPreparationService({
        configBuilder: new LocalAgentConfigBuilder({
            ...options.configBuilder,
            environment: options.configBuilder.environment ?? getLocalBashEnvironment,
        }),
        modelResolver: options.modelResolver,
    });
}
export function createAgentHostRuntimeLifecycle(runtime, mutations) {
    return {
        async disposeSession(sessionId) {
            await Promise.all([
                disposeRuntimeSession(runtime, sessionId),
                mutations?.clearSession(sessionId) ?? Promise.resolve(),
            ]);
        },
    };
}
function configuredNormalExtensions(extensions) {
    return extensions ?? [];
}
async function disposeRuntimeSession(runtime, sessionId) {
    runtime.disposeSession(sessionId);
}
function withTurnRuntimeFacts(turnRuntimeFacts) {
    return turnRuntimeFacts ? { turnRuntimeFacts } : {};
}
function createToolCatalogSource(options) {
    return {
        build: (input) => buildToolCatalog(options, input),
    };
}
async function buildToolCatalog(options, input) {
    return buildLocalTurnToolCatalog({
        sessionId: input.sessionId,
        sources: await options.resolveSources(toolCatalogSourceInput(input)),
        llmModel: input.llmModel,
        effectivePluginSkills: input.effectivePluginSkills,
        userText: input.userText,
        ...toolCatalogBuildOptions(options, input),
    });
}
function toolCatalogSourceInput(input) {
    return {
        ...input,
        ...agentProfileSourceOptions(input.agentProfile),
        ...runtimeSkillSelectorFacts(input.agentProfile),
    };
}
function agentProfileSourceOptions(profile) {
    return {
        ...(profile?.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(profile?.skipAgentResolution ? { skipAgentResolution: true } : {}),
        ...(profile?.expectedAgentInstanceId
            ? { expectedAgentInstanceId: profile.expectedAgentInstanceId }
            : {}),
        ...(profile?.agentMemoryEnabled === undefined
            ? {}
            : { agentMemoryEnabled: profile.agentMemoryEnabled }),
        ...(profile?.agentMemoryReadNames === undefined
            ? {}
            : { agentMemoryReadNames: profile.agentMemoryReadNames }),
    };
}
function toolCatalogBuildOptions(options, input) {
    return {
        ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        ...(input.modelCapabilities ? { modelCapabilities: input.modelCapabilities } : {}),
        ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
        ...(options.config ? { config: options.config } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.emitDiagnostic ? { emitDiagnostic: options.emitDiagnostic } : {}),
        ...(options.hostCapabilityRegistry
            ? { hostCapabilityRegistry: options.hostCapabilityRegistry }
            : {}),
    };
}
function runtimeSkillSelectorFacts(profile) {
    const selection = profile?.configSelection;
    return {
        ...(selection?.skills === undefined ? {} : { allowedSkillNames: selection.skills }),
        ...(selection?.extensionSkills === undefined
            ? {}
            : { allowedExtensionSkillNames: selection.extensionSkills }),
    };
}
//# sourceMappingURL=native-production-dependencies.js.map