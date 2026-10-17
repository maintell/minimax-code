import { BuiltinAgentCatalog, resolveCanonicalCapabilities, } from '../../builtin/catalog.js';
import { LEGACY_PRIMARY_AGENT_NAME } from '../../domain/names.js';
import { AgentConfigError } from '../../storage/canonical-agent-config.js';
import { patchCanonicalMarkdown } from '../../storage/canonical-agent-patch.js';
import { AgentConfigRevisionConflictError } from '../../storage/agent-files.js';
import { resolveLocale } from '../../domain/validation.js';
export async function rebuildBuiltinCanonicalFiles(input) {
    await removeRetiredLegacyPrimaryBuiltinFile(input.repository);
    if (!input.repository.writeBuiltinCanonicalConfig)
        return;
    for (const definition of input.definitions) {
        await rebuildBuiltinCanonicalFile(input, definition);
    }
}
/** `main` is only a compatibility owner; its old launch file cannot execute. */
async function removeRetiredLegacyPrimaryBuiltinFile(repository) {
    await repository.removeBuiltinCanonicalConfig?.(LEGACY_PRIMARY_AGENT_NAME);
}
async function rebuildBuiltinCanonicalFile(input, definition) {
    const capabilities = resolveCanonicalCapabilities(undefined, definition.capabilityOverride);
    const previous = await readExistingBuiltinConfig(input.repository, definition.name);
    if (previous) {
        await migrateLegacyBuiltinCanonicalTemplate(input, definition, capabilities);
        return;
    }
    const content = await input.catalog.readCanonicalTemplate({
        agentName: definition.name,
        surface: 'interactive',
        promptProfile: 'desktop',
        appMode: 'coding',
        locale: resolveLocale(),
        promptChannel: 'online',
        capabilities,
    });
    const modelGroup = await resolveBuiltinModelGroup({
        resolver: input.modelGroupResolver,
        bundled: input.bundledModelGroup,
    });
    await input.repository.writeBuiltinCanonicalConfig?.(definition.name, toBuiltinCanonicalConfig(definition, modelGroup, capabilities, content));
}
async function migrateLegacyBuiltinCanonicalTemplate(input, definition, capabilities) {
    if (!input.repository.readCanonicalDocument || !input.repository.replaceCanonicalDocument)
        return;
    const document = await input.repository.readCanonicalDocument(definition.name, true);
    let legacyContent;
    try {
        legacyContent = await input.catalog.readCanonicalContent({
            agentName: definition.name,
            surface: 'interactive',
            appMode: 'coding',
            locale: resolveLocale(),
            promptChannel: 'online',
            capabilities,
        });
    }
    catch {
        // This optional recognition pass must not make a valid user-owned source
        // unavailable when a retired bundled asset is no longer installed.
        return;
    }
    if (document.config.systemPrompt !== mergeBuiltinAgentSystemPrompt(legacyContent))
        return;
    const template = await input.catalog.readCanonicalTemplate({
        agentName: definition.name,
        surface: 'interactive',
        promptProfile: 'desktop',
        appMode: 'coding',
        locale: resolveLocale(),
        promptChannel: 'online',
        capabilities,
    });
    const content = patchCanonicalMarkdown(document.content, definition.name, { systemPrompt: mergeBuiltinAgentSystemPrompt(template) }, undefined);
    try {
        await input.repository.replaceCanonicalDocument({
            name: definition.name,
            content,
            expectedRevision: document.revision,
            builtin: true,
            archiveCurrentBuiltin: true,
        });
    }
    catch (error) {
        if (error instanceof AgentConfigRevisionConflictError)
            return;
        throw error;
    }
}
/**
 * Generates the dynamic bundled baseline returned by Config GET. The caller
 * may pass a currently selected model group so Reset restores platform-owned
 * prompt/capabilities without discarding a user's persistent model choice.
 */
export async function buildBuiltinCanonicalBaseline(input) {
    const capabilities = resolveCanonicalCapabilities(undefined, input.definition.capabilityOverride);
    const content = await input.catalog.readCanonicalTemplate({
        agentName: input.definition.name,
        surface: 'interactive',
        promptProfile: 'desktop',
        appMode: 'coding',
        locale: resolveLocale(),
        promptChannel: 'online',
        capabilities,
    });
    return toBuiltinCanonicalConfig(input.definition, input.modelGroup, capabilities, content);
}
export function builtinModelGroupFromCanonical(config) {
    return modelGroupFromCanonical(config);
}
async function readExistingBuiltinConfig(repository, name) {
    if (!repository.getBuiltinCanonicalConfig)
        return undefined;
    try {
        return await repository.getBuiltinCanonicalConfig(name);
    }
    catch (error) {
        if (error instanceof AgentConfigError && error.code === 'AGENT_CONFIG_NOT_FOUND') {
            return undefined;
        }
        throw error;
    }
}
function toBuiltinCanonicalConfig(definition, modelGroup, capabilities, content) {
    const xMavis = builtinMavisConfig(definition, modelGroup);
    return {
        name: definition.name,
        description: definition.identity.description?.trim() || definition.name,
        ...(xMavis ? { xMavis } : {}),
        ...(modelGroup?.model ? { model: modelGroup.model } : {}),
        ...(modelGroup?.effort ? { effort: modelGroup.effort } : {}),
        ...(capabilities.tools === undefined ? {} : { tools: capabilities.tools }),
        // `builtinTools` are tool IDs, not MCP server names. Absence here inherits
        // the ready server inventory, which is the bundled default.
        ...(capabilities.skills === undefined ? {} : { skills: capabilities.skills }),
        features: { ...capabilities.features },
        systemPrompt: mergeBuiltinAgentSystemPrompt(content),
    };
}
function builtinMavisConfig(definition, modelGroup) {
    const displayName = definition.identity.displayName?.trim() || undefined;
    const contextWindow = modelGroup?.contextWindow;
    const maxOutputTokens = modelGroup?.maxOutputTokens;
    if (displayName === undefined && contextWindow === undefined && maxOutputTokens === undefined) {
        return undefined;
    }
    return {
        ...(displayName ? { displayName } : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };
}
async function resolveBuiltinModelGroup(input) {
    if (input.resolver)
        return input.resolver({ bundled: input.bundled });
    return undefined;
}
function modelGroupFromCanonical(config) {
    if (!config)
        return undefined;
    const group = {
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.xMavis?.contextWindow === undefined
            ? {}
            : { contextWindow: config.xMavis.contextWindow }),
        ...(config.xMavis?.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: config.xMavis.maxOutputTokens }),
    };
    return Object.keys(group).length > 0 ? group : undefined;
}
function mergeBuiltinAgentSystemPrompt(content) {
    const parts = [content.persona?.trim() ?? '', content.systemPrompt?.trim() ?? ''].filter(Boolean);
    return parts.join('\n\n');
}
//# sourceMappingURL=builtin-canonical-files.js.map