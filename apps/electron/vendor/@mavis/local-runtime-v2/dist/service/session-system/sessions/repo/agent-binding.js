export function normalizeSessionAgentDefinition(input) {
    validateFrozenDefinition(input.definition);
    return { definition: freezeDefinition(input.definition) };
}
export function decodeSessionAgentDefinition(input) {
    let decoded;
    try {
        decoded = JSON.parse(input.definitionJson);
    }
    catch {
        throw new Error('Frozen Session Agent definition is not valid JSON.');
    }
    return { sessionId: input.sessionId, definition: decodeFrozenDefinition(decoded) };
}
export function serializeSessionAgentDefinition(input) {
    return { definitionJson: JSON.stringify(normalizeSessionAgentDefinition(input).definition) };
}
/** Legacy aliases are deliberately retained for V1 API consumers and migrations. */
export const normalizeTaskSessionBinding = normalizeSessionAgentDefinition;
export const decodeTaskSessionBinding = decodeSessionAgentDefinition;
export const serializeTaskSessionBinding = serializeSessionAgentDefinition;
export function isCurrentSessionAgentDefinition(definition) {
    return definition.definitionVersion === 2;
}
/** Copies a V2 frozen definition for a Fork while rebinding its Project. */
export function withCurrentSessionAgentDefinitionProject(input, project) {
    if (!isCurrentSessionAgentDefinition(input.definition)) {
        throw new Error('Forked Session Agent definition must be V2.');
    }
    return { definition: { ...input.definition, project } };
}
/** Downlevel mirror used only for Task rollback compatibility. */
export function toLegacyTaskSessionBinding(input) {
    const normalized = normalizeSessionAgentDefinition(input).definition;
    if (normalized.definitionVersion === 1)
        return { definition: normalized };
    return {
        definition: {
            definitionVersion: 1,
            systemPrompt: normalized.systemPrompt,
            ...(normalized.promptSnapshot ? { promptSnapshot: normalized.promptSnapshot } : {}),
            capabilities: normalized.capabilities,
        },
    };
}
function decodeFrozenDefinition(value) {
    if (!isRecord(value) || typeof value.systemPrompt !== 'string') {
        throw new Error('Frozen Session Agent definition is invalid.');
    }
    const capabilities = value.capabilities;
    if (!isRecord(capabilities))
        throw new Error('Frozen Session Agent capabilities are invalid.');
    const base = {
        systemPrompt: value.systemPrompt,
        ...(value.promptSnapshot === undefined
            ? {}
            : { promptSnapshot: decodeAgentPromptSnapshot(value.promptSnapshot) }),
        capabilities: decodeCapabilities(capabilities),
    };
    if (value.definitionVersion === 1) {
        return freezeDefinition({ definitionVersion: 1, ...base });
    }
    if (value.definitionVersion !== 2 || typeof value.exactOwnerName !== 'string') {
        throw new Error('Frozen Session Agent definition is invalid.');
    }
    const exactOwnerName = value.exactOwnerName.trim();
    if (!exactOwnerName)
        throw new Error('Frozen Session Agent owner is invalid.');
    const model = decodeModel(value.model);
    const project = decodeProject(value.project);
    const definition = {
        definitionVersion: 2,
        exactOwnerName,
        ...frozenOwnerFields(optionalNonEmptyString(value.ownerInstanceId, 'ownerInstanceId'), value.pluginSource),
        model,
        project,
        ...base,
    };
    validatePluginSourceOwner(definition);
    return freezeDefinition(definition);
}
function validateFrozenDefinition(definition) {
    if (typeof definition.systemPrompt !== 'string') {
        throw new Error('Frozen Session Agent definition is invalid.');
    }
    if (definition.promptSnapshot !== undefined)
        decodeAgentPromptSnapshot(definition.promptSnapshot);
    for (const field of REQUIRED_FROZEN_CAPABILITY_FIELDS) {
        validateStringArray(definition.capabilities[field]);
    }
    if (definition.capabilities.disallowedTools !== undefined) {
        validateStringArray(definition.capabilities.disallowedTools);
    }
    if (definition.definitionVersion === 1)
        return;
    if (definition.definitionVersion !== 2 || !definition.exactOwnerName.trim()) {
        throw new Error('Frozen Session Agent owner is invalid.');
    }
    validateModel(definition.model);
    validateProject(definition.project);
    if (definition.ownerInstanceId !== undefined && !definition.ownerInstanceId.trim()) {
        throw new Error('Frozen Session Agent owner instance is invalid.');
    }
    validatePluginSourceOwner(definition);
}
/** A Plugin Agent has no Custom Agent incarnation and is owned by its scoped name. */
function validatePluginSourceOwner(definition) {
    if (definition.pluginSource === undefined)
        return;
    const source = decodePluginSource(definition.pluginSource);
    if (definition.ownerInstanceId || source.scopedName !== definition.exactOwnerName) {
        throw new Error('Frozen Session Agent Plugin source is invalid.');
    }
}
function frozenOwnerFields(ownerInstanceId, pluginSource) {
    return {
        ...(ownerInstanceId ? { ownerInstanceId } : {}),
        ...(pluginSource === undefined
            ? {}
            : { pluginSource: Object.freeze(decodePluginSource(pluginSource)) }),
    };
}
function freezeDefinition(definition) {
    const base = {
        systemPrompt: definition.systemPrompt,
        ...(definition.promptSnapshot === undefined
            ? {}
            : { promptSnapshot: decodeAgentPromptSnapshot(definition.promptSnapshot) }),
        capabilities: Object.freeze({
            tools: Object.freeze([...definition.capabilities.tools]),
            ...(definition.capabilities.disallowedTools === undefined
                ? {}
                : { disallowedTools: Object.freeze([...definition.capabilities.disallowedTools]) }),
            mcpServers: Object.freeze([...definition.capabilities.mcpServers]),
            skills: Object.freeze([...definition.capabilities.skills]),
            extensionSkills: Object.freeze([...definition.capabilities.extensionSkills]),
        }),
    };
    if (definition.definitionVersion === 1) {
        return Object.freeze({ definitionVersion: 1, ...base });
    }
    return Object.freeze({
        definitionVersion: 2,
        exactOwnerName: definition.exactOwnerName,
        ...frozenOwnerFields(definition.ownerInstanceId, definition.pluginSource),
        model: Object.freeze({
            providerId: definition.model.providerId,
            modelId: definition.model.modelId,
            ...(definition.model.parameterSnapshot
                ? { parameterSnapshot: Object.freeze({ ...definition.model.parameterSnapshot }) }
                : {}),
            ...(definition.model.variant === undefined ? {} : { variant: definition.model.variant }),
            ...(definition.model.thinking ? { thinking: freezeThinking(definition.model.thinking) } : {}),
            ...(definition.model.contextWindow === undefined
                ? {}
                : { contextWindow: definition.model.contextWindow }),
            ...(definition.model.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: definition.model.maxOutputTokens }),
        }),
        project: Object.freeze({ ...definition.project }),
        ...base,
    });
}
function decodeCapabilities(capabilities) {
    return {
        tools: requiredStringArray(capabilities, 'tools'),
        ...optionalStringArray(capabilities, 'disallowedTools'),
        mcpServers: requiredStringArray(capabilities, 'mcpServers'),
        skills: requiredStringArray(capabilities, 'skills'),
        extensionSkills: requiredStringArray(capabilities, 'extensionSkills'),
    };
}
function decodeModel(value) {
    if (!isRecord(value))
        throw new Error('Frozen Session Agent model is invalid.');
    const providerId = requiredNonEmptyString(value.providerId, 'providerId');
    const modelId = requiredNonEmptyString(value.modelId, 'modelId');
    const variant = optionalString(value.variant, 'variant');
    const thinking = decodeThinking(value.thinking);
    const contextWindow = optionalPositiveInteger(value.contextWindow, 'contextWindow');
    const maxOutputTokens = optionalPositiveInteger(value.maxOutputTokens, 'maxOutputTokens');
    const parameterSnapshot = decodeParameterSnapshot(value.parameterSnapshot);
    return {
        providerId,
        modelId,
        ...(parameterSnapshot ? { parameterSnapshot } : {}),
        ...(variant === undefined ? {} : { variant }),
        ...(thinking ? { thinking } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };
}
function decodeParameterSnapshot(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value) ||
        !['default', 'selection', 'legacy'].includes(String(value.context)) ||
        !['default', 'selection', 'legacy'].includes(String(value.effort)))
        throw new Error('Frozen model parameter provenance is invalid.');
    return {
        context: value.context,
        effort: value.effort,
    };
}
function decodeProject(value) {
    if (!isRecord(value))
        throw new Error('Frozen Session Agent project is invalid.');
    const workspaceDir = requiredNonEmptyString(value.workspaceDir, 'workspaceDir');
    if (typeof value.isDefaultWorkspace !== 'boolean') {
        throw new Error('Frozen Session Agent default workspace marker is invalid.');
    }
    return { workspaceDir, isDefaultWorkspace: value.isDefaultWorkspace };
}
function validateModel(model) {
    decodeParameterSnapshot(model.parameterSnapshot);
    requiredNonEmptyString(model.providerId, 'providerId');
    requiredNonEmptyString(model.modelId, 'modelId');
    if (model.variant !== undefined && typeof model.variant !== 'string') {
        throw new Error('Frozen Session Agent variant is invalid.');
    }
    if (model.thinking)
        validateThinking(model.thinking);
    if (model.contextWindow !== undefined)
        optionalPositiveInteger(model.contextWindow, 'contextWindow');
    if (model.maxOutputTokens !== undefined)
        optionalPositiveInteger(model.maxOutputTokens, 'maxOutputTokens');
}
const PLUGIN_SOURCE_FORMATS = new Set(['minimax', '\u0063\u006c\u0061\u0075\u0064\u0065']);
function decodePluginSource(value) {
    if (!isRecord(value) ||
        value.kind !== 'plugin' ||
        !PLUGIN_SOURCE_FORMATS.has(String(value.format))) {
        throw new Error('Frozen Session Agent Plugin source is invalid.');
    }
    return {
        kind: 'plugin',
        pluginName: requiredNonEmptyString(value.pluginName, 'pluginSource.pluginName'),
        format: value.format,
        agentName: requiredNonEmptyString(value.agentName, 'pluginSource.agentName'),
        scopedName: requiredNonEmptyString(value.scopedName, 'pluginSource.scopedName'),
        packageDigest: requiredNonEmptyString(value.packageDigest, 'pluginSource.packageDigest'),
    };
}
function validateProject(project) {
    requiredNonEmptyString(project.workspaceDir, 'workspaceDir');
    if (typeof project.isDefaultWorkspace !== 'boolean') {
        throw new Error('Frozen Session Agent default workspace marker is invalid.');
    }
}
function requiredNonEmptyString(value, field) {
    const normalized = optionalNonEmptyString(value, field);
    if (!normalized)
        throw new Error(`Frozen Session Agent ${field} is invalid.`);
    return normalized;
}
function optionalNonEmptyString(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`Frozen Session Agent ${field} is invalid.`);
    }
    return value.trim();
}
function optionalString(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'string') {
        throw new Error(`Frozen Session Agent ${field} is invalid.`);
    }
    return value;
}
function decodeThinking(value) {
    if (value === undefined)
        return undefined;
    if (!isRecord(value))
        throw new Error('Frozen Session Agent thinking is invalid.');
    const thinking = {
        ...(value.effort === undefined
            ? {}
            : { effort: optionalString(value.effort, 'thinking.effort') }),
        ...(value.off_behavior === undefined
            ? {}
            : { off_behavior: optionalString(value.off_behavior, 'thinking.off_behavior') }),
        ...(value.budgets === undefined ? {} : { budgets: decodeThinkingBudgets(value.budgets) }),
    };
    validateThinking(thinking);
    return thinking;
}
function decodeThinkingBudgets(value) {
    if (!isRecord(value))
        throw new Error('Frozen Session Agent thinking budgets are invalid.');
    const budgets = {};
    for (const key of THINKING_BUDGET_KEYS) {
        const budget = value[key];
        if (budget === undefined)
            continue;
        if (typeof budget !== 'string' && typeof budget !== 'number') {
            throw new Error(`Frozen Session Agent thinking.budgets.${key} is invalid.`);
        }
        budgets[key] = budget;
    }
    return budgets;
}
function validateThinking(thinking) {
    if (thinking.effort !== undefined && typeof thinking.effort !== 'string') {
        throw new Error('Frozen Session Agent thinking.effort is invalid.');
    }
    if (thinking.off_behavior !== undefined && typeof thinking.off_behavior !== 'string') {
        throw new Error('Frozen Session Agent thinking.off_behavior is invalid.');
    }
    if (thinking.budgets !== undefined)
        decodeThinkingBudgets(thinking.budgets);
}
function freezeThinking(thinking) {
    return Object.freeze({
        ...(thinking.effort === undefined ? {} : { effort: thinking.effort }),
        ...(thinking.off_behavior === undefined ? {} : { off_behavior: thinking.off_behavior }),
        ...(thinking.budgets === undefined ? {} : { budgets: Object.freeze({ ...thinking.budgets }) }),
    });
}
const THINKING_BUDGET_KEYS = ['minimal', 'low', 'medium', 'high'];
function optionalPositiveInteger(value, field) {
    if (value === undefined)
        return undefined;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Frozen Session Agent ${field} is invalid.`);
    }
    return value;
}
const REQUIRED_FROZEN_CAPABILITY_FIELDS = [
    'tools',
    'mcpServers',
    'skills',
    'extensionSkills',
];
function optionalStringArray(source, field) {
    const value = source[field];
    if (value === undefined)
        return {};
    validateStringArray(value);
    return { [field]: [...value] };
}
function requiredStringArray(source, field) {
    const value = source[field];
    if (value === undefined) {
        throw new Error(`Frozen Task Agent capability ${field} is required.`);
    }
    validateStringArray(value);
    return [...value];
}
function validateStringArray(value) {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error('Frozen Task Agent capabilities must be string arrays.');
    }
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function decodeAgentPromptSnapshot(value) {
    if (!isRecord(value) ||
        !['tui', 'coding', 'work'].includes(String(value.mode)) ||
        typeof value.template !== 'string' ||
        typeof value.systemPrompt !== 'string' ||
        (value.version !== undefined && typeof value.version !== 'string')) {
        throw new Error('Frozen Agent Prompt snapshot is invalid.');
    }
    return Object.freeze({
        mode: value.mode,
        ...(value.version === undefined ? {} : { version: value.version }),
        template: value.template,
        systemPrompt: value.systemPrompt,
    });
}
//# sourceMappingURL=agent-binding.js.map