import { describeAgentPromptSnapshot } from '../../service/agent/index.js';
import { isLegacyMemoryRecallEnabled, isLocalSourceProvenanceEnabled } from '@mavis/config';
import { omitManagedSourceCitationInstructions, restoreLegacyFileReferenceInstructions, } from '@mavis/shared/source-provenance';
import { resolveAgentPromptSurface } from '../../service/turn-system/index.js';
import { isTaskSession, isCurrentSessionAgentDefinition, } from '../../service/session-system/index.js';
export function createV2AgentProfileSource(agentService, configGetter, runtimeOwnerKind, capabilityProfile) {
    return {
        render: async ({ session, agent, agentBinding, promptRead }) => {
            const definition = requireCurrentDefinition(session, agentBinding);
            const metadata = agent.metadata ?? {};
            // Freeze one config snapshot for the complete profile render so a live
            // preference update cannot mix capability, memory, and dataDir versions.
            const config = configGetter();
            const capabilities = resolveConfiguredCapabilities(config, capabilityProfile);
            const frozenOwner = definition?.exactOwnerName;
            const requestRef = frozenOwner
                ? `agent:${frozenOwner}`
                : readMetadataRequestRef(metadata.requestRef);
            const request = {
                // Execution behavior follows the frozen canonical owner, while the
                // persisted Session may retain a legacy primary-family storage owner.
                exactOwnerName: frozenOwner ?? agent.executionOwnerName ?? agent.agentName,
                ...(requestRef === undefined ? {} : { requestRef }),
                surface: resolveAgentPromptSurface(session, runtimeOwnerKind),
                promptProfile: runtimeOwnerKind === 'tui' ? 'tui' : 'desktop',
                appMode: session.appMode ?? 'coding',
                capabilities,
                memoryEnabled: !isCommandLineRuntimeOwner(runtimeOwnerKind) &&
                    isLegacyMemoryRecallEnabled(config.memory, agent.agentName),
                cronEnabled: !isCommandLineRuntimeOwner(runtimeOwnerKind),
                dataDirToken: config.dataDir,
                ...(promptRead ? { promptReadContext: promptRead } : {}),
            };
            const profile = await renderProfile(agentService, request, definition);
            return toLocalAgentExecutionProfile(applySourcePromptPolicy(profile, runtimeOwnerKind));
        },
    };
}
function renderProfile(agentService, request, definition) {
    return definition
        ? agentService.renderFrozenProfile(request, frozenDefinition(definition))
        : agentService.renderProfile(request);
}
function resolveConfiguredCapabilities(config, capabilityProfile) {
    const configured = config.agents?.default;
    if (capabilityProfile !== 'cli')
        return configured;
    return {
        ...configured,
        features: { ...configured?.features, mavis: false },
    };
}
function requireCurrentDefinition(session, binding) {
    if (!isTaskSession(session))
        return undefined;
    const { sessionId } = session;
    if (!binding)
        return undefined;
    if (binding.sessionId !== sessionId)
        throw new Error(`Session Agent definition owner mismatch: ${sessionId}`);
    if (!isCurrentSessionAgentDefinition(binding.definition)) {
        throw new Error(`Session Agent definition requires migration: ${sessionId}`);
    }
    return binding.definition;
}
function readMetadataRequestRef(value) {
    return typeof value === 'string' ? value : undefined;
}
export function isCommandLineRuntimeOwner(runtimeOwnerKind) {
    return runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui';
}
function applySourcePromptPolicy(profile, runtimeOwnerKind) {
    // Apply after Apollo/frozen profile resolution, before prompt range assembly.
    if (isLocalSourceProvenanceEnabled(runtimeOwnerKind))
        return profile;
    return {
        ...profile,
        corePrompt: restoreLegacyFileReferenceInstructions(omitManagedSourceCitationInstructions(profile.corePrompt)),
        ...(profile.agentSystemPrompt !== undefined
            ? { agentSystemPrompt: omitManagedSourceCitationInstructions(profile.agentSystemPrompt) }
            : {}),
    };
}
function toLocalAgentExecutionProfile(profile) {
    return {
        ...(profile.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(profile.skipAgentResolution ? { skipAgentResolution: true } : {}),
        ...(profile.expectedAgentInstanceId
            ? { expectedAgentInstanceId: profile.expectedAgentInstanceId }
            : {}),
        requestRef: profile.requestRef,
        resourceReadRef: profile.resourceReadRef,
        exactOwnerName: profile.exactOwnerName,
        canonicalViewName: profile.canonicalViewName,
        resolvedAgentName: profile.resolvedAgentName,
        agentRole: profile.agentRole,
        creationSource: profile.creationSource,
        surface: profile.surface,
        memoryReadAgentNames: profile.memoryReadAgentNames,
        ...(profile.persona !== undefined ? { persona: profile.persona } : {}),
        ...(profile.agentSystemPrompt !== undefined
            ? { agentSystemPrompt: profile.agentSystemPrompt }
            : {}),
        ...(profile.promptSnapshot
            ? { promptMetadata: describeAgentPromptSnapshot(profile.promptSnapshot) }
            : {}),
        corePrompt: profile.corePrompt,
        surfacePrompt: profile.surfacePrompt,
        ...(profile.configSelection ? { configSelection: profile.configSelection } : {}),
        capabilityCeiling: profile.capabilityCeiling,
        provenance: profile.provenance,
    };
}
function frozenDefinition(input) {
    return {
        ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
        systemPrompt: input.systemPrompt,
        ...(input.promptSnapshot ? { promptSnapshot: input.promptSnapshot } : {}),
        capabilities: input.capabilities,
    };
}
//# sourceMappingURL=profile-source.js.map