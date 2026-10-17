export function createLocalTurnToolCatalogInput(context, desktopCapabilities) {
    const modelCapabilities = readModelCapabilities(context.model);
    const builtinCapabilities = readBuiltinCapabilities(context.agentConfig);
    const agentProfile = readAgentProfile(context.agentConfig);
    return {
        sessionId: context.sessionId,
        turnId: context.turnId,
        agentName: context.agentName,
        resourceAgentName: readString(context.agentConfig, 'resourceAgentName') ?? context.agentName,
        ...(builtinCapabilities ? { builtinCapabilities } : {}),
        computerUseActive: context.agentConfig.computerUseActive === true,
        workspaceDir: context.workspaceDir,
        llmModel: readResolvedModel(context.model),
        effectivePluginSkills: readEffectivePluginSkills(context.agentConfig),
        ...(context.userInput ? { userText: context.userInput.text } : {}),
        ...(modelCapabilities ? { modelCapabilities } : {}),
        ...(agentProfile ? { agentProfile } : {}),
        ...(desktopCapabilities ? { desktopCapabilities } : {}),
    };
}
function readEffectivePluginSkills(agentConfig) {
    const value = agentConfig.desktopPluginSkills;
    if (!Array.isArray(value))
        return [];
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return [];
        const pluginName = Reflect.get(entry, 'pluginName');
        const name = Reflect.get(entry, 'name');
        return typeof pluginName === 'string' && typeof name === 'string' ? [{ pluginName, name }] : [];
    });
}
function readBuiltinCapabilities(agentConfig) {
    const value = agentConfig.builtinCapabilities;
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function readAgentProfile(config) {
    const ceiling = readRecord(config.capability_ceiling);
    const features = readRecord(ceiling.features);
    if (!hasValidCapabilityCeiling(ceiling, features))
        return undefined;
    const profile = readRecord(config.agent_profile);
    const { trustedBuiltin, canonicalViewName } = readTrustedBuiltinAgentProfileIdentity(profile);
    const configSelection = readConfigSelection(profile);
    return {
        capabilityCeiling: toCapabilityCeiling(ceiling, features),
        ...agentProfileResourceFacts(profile),
        ...agentProfileIdentityFacts(profile, canonicalViewName, trustedBuiltin),
        trustedBuiltin,
        ...agentProfileMemoryFacts(profile),
        ...(configSelection ? { configSelection } : {}),
    };
}
function agentProfileResourceFacts(profile) {
    const expectedAgentInstanceId = readString(profile, 'expected_agent_instance_id');
    return {
        ...(profile.exclude_agent_resources === true ? { excludeAgentResources: true } : {}),
        ...(profile.skip_agent_resolution === true ? { skipAgentResolution: true } : {}),
        ...(expectedAgentInstanceId ? { expectedAgentInstanceId } : {}),
    };
}
function agentProfileIdentityFacts(profile, canonicalViewName, trustedBuiltin) {
    let surface = 'interactive';
    if (profile.surface === 'task-child')
        surface = 'task-child';
    else if (profile.surface === 'cli')
        surface = 'cli';
    return {
        ...(canonicalViewName && trustedBuiltin ? { canonicalRole: canonicalViewName } : {}),
        surface,
    };
}
function agentProfileMemoryFacts(profile) {
    const agentMemoryReadNames = readStringArray(profile, 'memory_read_agent_names');
    return {
        ...(typeof profile.memory_agent_scope_enabled === 'boolean'
            ? { agentMemoryEnabled: profile.memory_agent_scope_enabled }
            : {}),
        ...(agentMemoryReadNames ? { agentMemoryReadNames } : {}),
    };
}
function readConfigSelection(profile) {
    const source = readRecord(profile.config_selection);
    const selection = {
        ...optionalStringArray(source, 'tools'),
        ...optionalStringArray(source, 'disallowedTools'),
        ...optionalStringArray(source, 'mcpServers'),
        ...optionalStringArray(source, 'skills'),
        ...optionalStringArray(source, 'extensionSkills'),
    };
    return Object.keys(selection).length > 0 ? selection : undefined;
}
function optionalStringArray(record, key) {
    const value = record[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
        return {};
    return { [key]: value.map((entry) => entry.trim()).filter(Boolean) };
}
function readStringArray(record, key) {
    const value = record[key];
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
        ? value.map((entry) => entry.trim()).filter(Boolean)
        : undefined;
}
function hasValidCapabilityCeiling(ceiling, features) {
    return (typeof ceiling.personaEnabled === 'boolean' &&
        typeof features.mavis === 'boolean' &&
        typeof features.delegation === 'boolean' &&
        typeof features.webSearch === 'boolean');
}
export function readTrustedBuiltinAgentProfileIdentity(value) {
    const profile = readRecord(value);
    const canonicalViewName = readString(profile, 'canonical_view_name');
    return {
        trustedBuiltin: typeof profile.trusted_builtin === 'boolean'
            ? profile.trusted_builtin
            : profile.creation_source === 'builtin' &&
                (profile.provenance_source === 'builtin' ||
                    profile.provenance_source === 'legacy-read-through'),
        ...(canonicalViewName ? { canonicalViewName } : {}),
    };
}
function toCapabilityCeiling(ceiling, features) {
    return {
        personaEnabled: ceiling.personaEnabled,
        ...(Array.isArray(ceiling.tools) ? { tools: ceiling.tools } : {}),
        ...(Array.isArray(ceiling.builtinTools) ? { builtinTools: ceiling.builtinTools } : {}),
        ...(Array.isArray(ceiling.skills) ? { skills: ceiling.skills } : {}),
        features: {
            mavis: features.mavis,
            delegation: features.delegation,
            webSearch: features.webSearch,
        },
    };
}
function readRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function readResolvedModel(model) {
    const provider = readString(model, 'provider');
    const id = readString(model, 'model_id', 'modelId', 'id');
    const contextWindow = readPositiveNumber(model, 'context_window', 'contextWindow');
    if (!provider || !id || !contextWindow) {
        throw new Error('Local tool assembly requires a resolved provider, model id, and context window.');
    }
    return { provider, id, contextWindow };
}
function readModelCapabilities(model) {
    const value = model.capabilities;
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function readString(record, ...keys) {
    return keys
        .map((key) => record[key])
        .find((value) => typeof value === 'string' && value.trim().length > 0)
        ?.trim();
}
function readPositiveNumber(record, ...keys) {
    return keys
        .map((key) => record[key])
        .find((value) => typeof value === 'number' && value > 0);
}
//# sourceMappingURL=local-turn-tool-catalog-source.js.map