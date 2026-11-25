import { describeAgentPromptSnapshot } from '../../service/agent/index.js';
import { isBunnyMemoryEnabledInConfig, isBunnyVerdictGateEnabledInConfig, isLegacyMemoryRecallEnabled, isLocalSourceProvenanceEnabled, normalizePluginName, } from '@mavis/config';
import { omitManagedSourceCitationInstructions, restoreLegacyFileReferenceInstructions, } from '@mavis/shared/source-provenance';
import { resolveAgentPromptSurface } from '../../service/turn-system/index.js';
import { isPeekSession, isTaskSession, isCurrentSessionAgentDefinition, } from '../../service/session-system/index.js';
export function createV2AgentProfileSource(agentService, configGetter, runtimeOwnerKind, capabilityProfile) {
    // Frozen plugin tasks retain their definition, but startup policy still gates new turns.
    const forbiddenPluginNames = new Set((configGetter().plugins?.forbidden ?? []).map(normalizePluginName));
    const onlyOfficialPlugins = configGetter().plugins?.onlyOfficial === true;
    return {
        render: async ({ session, agent, agentBinding, promptRead, ptcRequested, ptcStoreRequested, }) => {
            const definition = requireCurrentDefinition(session, agentBinding, forbiddenPluginNames, onlyOfficialPlugins);
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
                ...bunnyPromptSwitches(config),
                ...(supportsInlineActions(config, session, runtimeOwnerKind)
                    ? { inlineActions: true }
                    : {}),
                dataDirToken: config.dataDir,
                ...turnScopedRequest(promptRead, ptcRequested, ptcStoreRequested),
            };
            const profile = await renderProfile(agentService, request, definition);
            return toLocalAgentExecutionProfile(applySourcePromptPolicy(profile, runtimeOwnerKind));
        },
    };
}
/**
 * Bunny's local config.yaml switches, off by default; only Bunny's own profile reads them: the
 * read-only helper paragraphs (`bunny.helperAgents`), the memory paragraphs (`bunny.memory`) and
 * the review-dispatch paragraphs (`bunny.verdictGate`).
 */
function bunnyPromptSwitches(config) {
    return {
        ...(config.bunny?.helperAgents === true ? { bunnyHelperAgents: true } : {}),
        ...(isBunnyMemoryEnabledInConfig(config) ? { bunnyMemory: true } : {}),
        ...(isBunnyVerdictGateEnabledInConfig(config) ? { bunnyVerdictGate: true } : {}),
    };
}
/** Facts that belong to this one Turn, never to the Agent definition. */
function turnScopedRequest(promptRead, ptcRequested, ptcStoreRequested) {
    return {
        ...(promptRead ? { promptReadContext: promptRead } : {}),
        ...(ptcRequested ? { ptcRequested: true } : {}),
        ...(ptcStoreRequested ? { ptcStoreRequested: true } : {}),
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
function requireCurrentDefinition(session, binding, forbiddenPluginNames, onlyOfficialPlugins = false) {
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
    const pluginName = binding.definition.pluginSource?.pluginName;
    if (pluginName && forbiddenPluginNames.has(normalizePluginName(pluginName))) {
        throw new Error(`Plugin forbidden by local config: ${pluginName}`);
    }
    // Definitions frozen without an origin predate official Plugin subagents: local.
    if (pluginName && onlyOfficialPlugins && binding.definition.pluginSource?.origin !== 'official') {
        throw new Error(`Plugin blocked until the plugins section of config.yaml is fixed: ${pluginName}`);
    }
    return binding.definition;
}
function readMetadataRequestRef(value) {
    return typeof value === 'string' ? value : undefined;
}
const NO_INLINE_ACTION_SESSION_KINDS = new Set([
    'channel',
    'cron',
]);
/**
 * Inline terminal and model actions run on the Electron host that renders the conversation.
 * SSH remotes (app-server), CLI/TUI and IM channel sessions have no such host. Cron runs and
 * hidden side questions (peek) have no user in the turn who could click Run. Builds without
 * `beta.inlineActions` (internal-only) never receive the protocol.
 */
function supportsInlineActions(config, session, runtimeOwnerKind) {
    return (config.beta?.inlineActions === true &&
        runtimeOwnerKind === 'electron' &&
        !NO_INLINE_ACTION_SESSION_KINDS.has(session.sessionKind) &&
        !isPeekSession(session));
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
        ...(profile.coordination ? { coordination: profile.coordination } : {}),
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