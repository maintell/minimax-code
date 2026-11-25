import { buildLocalTurnToolCatalog, } from '../../agent-host/assembly/local-turn-tool-catalog.js';
import { createLocalTurnToolCatalogInput, } from '../../agent-host/assembly/local-turn-tool-catalog-source.js';
import { observeAgentTurnSetupStage } from '../../agent-host/preparation/turn-preflight.js';
import { renderTurnSkillPreload } from '../../agent-host/tools/agent-skill-preload.js';
import { withUserQuestionTools } from '../../agent-host/tools/user-question-tools.js';
/** The normal profile: the Turn tool catalog seeds the shared Agent runtime. */
export function createNormalRuntimeProfile(runtime, options) {
    const catalog = createToolCatalogSource(options);
    return {
        async assembleModelContext(context, desktopCapabilities) {
            // A standalone compaction's catalog: same prefix window, but no Turn announces anything.
            const seed = await catalog.build({
                ...createLocalTurnToolCatalogInput(context, desktopCapabilities, false),
                commitWindow: false,
            }, context.history);
            return (await runtime()).assembleModelContext(context, seed);
        },
        async assembleTurn(context, desktopCapabilities) {
            const logContext = { sessionId: context.sessionId, turnId: context.turnId };
            const seed = await observeAgentTurnSetupStage(options.logger, logContext, 'tool_catalog_build', () => catalog.build(createLocalTurnToolCatalogInput(context, desktopCapabilities, context.sendsUserMessage), context.history));
            return observeAgentTurnSetupStage(options.logger, logContext, 'agent_runtime_assembly', async () => (await runtime()).assembleTurn(context, seed));
        },
    };
}
function createToolCatalogSource(options) {
    return {
        build: async (input, history) => {
            const contribution = await options.tools.contribute(toolSourceRequest(input));
            // Resolved before the catalog so a PTC Turn can name them: run_code answers
            // `tools.working_state` with "只能直接调用" instead of QuickJS's "not a
            // function", which is what a tool appended after the catalog used to get.
            const memoryTools = coordinatorMemoryTools(options, input);
            const built = buildLocalTurnToolCatalog({
                sessionId: input.sessionId,
                turnId: input.turnId,
                agentName: input.agentName,
                sources: withUserQuestionTools(contribution.tools),
                llmModel: input.llmModel,
                effectivePluginSkills: input.effectivePluginSkills,
                userText: input.userText,
                ptc: options.ptc,
                writePtcReturnArtifact: options.writePtcReturnArtifact,
                // The one receipt store this Runtime shares: the gate below, the preload
                // this build renders and the Host's own clears all read this instance.
                skillReceipts: options.policy.skillReceipts,
                // Absent when the matching beta switch is off, which leaves the catalog
                // exactly as it was before either switch existed.
                ...(options.ptc?.sessionStore ? { ptcSessionStore: options.ptc.sessionStore } : {}),
                ...(options.ptc?.scripts ? { ptcScripts: options.ptc.scripts } : {}),
                ...(contribution.promptBlocks ? { promptBlocks: contribution.promptBlocks } : {}),
                ...(input.commitWindow === false ? { commitWindow: false } : {}),
                ...turnHistoryOption(history),
                ...toolCatalogBuildOptions(options, input),
                ...(memoryTools.length > 0
                    ? { appendedDirectToolNames: memoryTools.map((tool) => tool.def.name) }
                    : {}),
            });
            const catalog = {
                ...built,
                tools: [...built.tools, ...memoryTools],
            };
            // Rendered into the first user message, which history then keeps; a trusted
            // coordinator re-injects once its namespace receipts are gone.
            const preload = await renderTurnSkillPreload({
                input,
                tools: built.gatedNativeTools,
                receipts: options.policy.skillReceipts,
                ...(contribution.tools.readSkill ? { readSkill: contribution.tools.readSkill } : {}),
                ...(options.logger ? { logger: options.logger } : {}),
            });
            if (!preload)
                return catalog;
            return {
                ...catalog,
                userPromptPrefix: [preload, catalog.userPromptPrefix].filter(Boolean).join('\n\n'),
            };
        },
    };
}
/** The Turn history the catalog restores receipts from; absent means nothing to restore. */
function turnHistoryOption(history) {
    return history === undefined ? {} : { history };
}
/** Product memory tools belong to a trusted profile that declares that memory pipeline. */
function coordinatorMemoryTools(options, input) {
    const profile = input.agentProfile;
    if (profile?.trustedBuiltin !== true || profile.coordination?.memoryPipeline === undefined)
        return [];
    return options.tools.coordinatorMemoryTools?.(input) ?? [];
}
function toolSourceRequest(input) {
    return {
        ...input,
        ...agentProfileSourceOptions(input.agentProfile),
    };
}
function agentProfileSourceOptions(profile) {
    return {
        ...(profile?.trustedBuiltin === true && profile.coordination
            ? { coordination: profile.coordination }
            : {}),
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
    return { ...turnToolCatalogFacts(input), ...hostToolCatalogOptions(options) };
}
/** Facts the caller resolved for this Turn. */
function turnToolCatalogFacts(input) {
    return {
        // Read only by ptcScriptSupport, which returns before touching them when
        // the Host wired no script host, so forwarding them changes no other Turn.
        workspaceDir: input.workspaceDir,
        ...(input.isDefaultWorkspace ? { isDefaultWorkspace: true } : {}),
        ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        ...(input.modelCapabilities ? { modelCapabilities: input.modelCapabilities } : {}),
        ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
        ...(input.ptcEnabled ? { ptcEnabled: true } : {}),
        ...(input.advisorBound ? { advisorBound: true } : {}),
    };
}
/** Host policy and capabilities shared by every Turn. */
function hostToolCatalogOptions(options) {
    const { config, env } = options.policy;
    return {
        ...(config ? { config } : {}),
        ...(env ? { env } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.tools.capabilities ? { hostCapabilityRegistry: options.tools.capabilities } : {}),
    };
}
//# sourceMappingURL=turn-runtime.js.map