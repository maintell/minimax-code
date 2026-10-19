import { toAgentRequestRef } from '@mavis/agent-tools/desktop/subagent-roles';
import { BuiltinAgentCatalog, canonicalBuiltinName, resolveCanonicalCapabilities, } from '../builtin/catalog.js';
import { AgentServiceError } from '../errors.js';
import { toBuiltinProfile, toBuiltinRenderInput, } from './listing/index.js';
import { applyBuiltinSubagentTaskChildCeiling, resolveLocale, toCapabilityCeiling, } from '../domain/validation.js';
import { PRIMARY_AGENT_NAME, normalizeRequestRef, parseExplicitNameOrStable, } from '../domain/names.js';
import { AgentConfigError } from '../storage/canonical-agent-config.js';
import { isPromptSnapshotInvalidError, } from '../../prompt-config/index.js';
const NO_AGENT_MEMORY = Object.freeze([]);
export async function buildAgentGreetingReminder(input, promptRead) {
    const view = await input.readView();
    const render = async (promptReadContext) => {
        const profile = await input.renderProfile(promptReadContext);
        const template = await input.catalog.readGreetingTemplate(profile.provenance.locale, promptReadContext);
        const facts = [
            `agent_name: ${view.exactOwnerName}`,
            view.displayName ? `display_name: ${view.displayName}` : undefined,
            view.description ? `description: ${view.description}` : undefined,
            `persona_present: ${profile.persona?.trim() ? 'true' : 'false'}`,
        ].filter((value) => Boolean(value));
        return [
            '<system-reminder>',
            'Reply in the user interface language when it is clear from context.',
            '',
            "## What's already set on you",
            ...facts,
            '',
            template,
            '</system-reminder>',
        ].join('\n');
    };
    if (promptRead)
        return render(promptRead);
    if (!input.promptConfig)
        return render();
    try {
        return await render(await input.promptConfig.capture());
    }
    catch (error) {
        if (!isPromptSnapshotInvalidError(error))
            throw error;
        return render(await input.promptConfig.captureBuiltin());
    }
}
export async function resolveAgentProfileRenderContext(input, dependencies) {
    const exactOwnerName = parseExplicitNameOrStable(input.exactOwnerName);
    const requestRef = normalizeRequestRef(input.requestRef ?? input.exactOwnerName);
    const meta = await dependencies.requireMeta(exactOwnerName);
    const resolvedAgentName = await dependencies.resolveExecutionTarget(exactOwnerName);
    const executionMeta = (await dependencies.repository.get(resolvedAgentName)) ?? meta;
    const canonicalViewName = resolvedAgentName !== exactOwnerName || dependencies.isBuiltin(meta)
        ? canonicalBuiltinName(resolvedAgentName)
        : exactOwnerName;
    const definition = dependencies.isBuiltin(executionMeta)
        ? await dependencies.definitionFor(canonicalViewName)
        : undefined;
    const capabilities = resolveCanonicalCapabilities(input.capabilities, definition?.capabilityOverride);
    // A manual Agent may deliberately use a reserved canonical name. The
    // persisted row remains its owner and must not read the built-in prompt.
    const canonicalBuiltin = dependencies.isBuiltin(executionMeta) && Boolean(definition);
    const surface = input.surface ?? 'interactive';
    // Historic per-Agent memory remains on disk for recovery, but only the
    // Runtime-owned Mavis/main family is admitted to the prompt pipeline.
    const memoryReadAgentNames = canonicalBuiltin && canonicalViewName === PRIMARY_AGENT_NAME
        ? await dependencies.resolveBuiltinReadAgentNames(canonicalViewName)
        : NO_AGENT_MEMORY;
    return {
        input,
        requestRef,
        exactOwnerName,
        resolvedAgentName,
        canonicalViewName,
        meta,
        executionMeta,
        capabilities: applyBuiltinSubagentTaskChildCeiling({
            capabilities,
            canonicalBuiltin,
            canonicalViewName,
            surface,
        }),
        surface,
        memoryReadAgentNames,
        canonicalBuiltin,
    };
}
export function createAgentPromptSelection(options) {
    const { promptMode, promptVersion } = options;
    if (promptMode !== undefined && !['tui', 'coding', 'work'].includes(promptMode)) {
        throw new Error(`Invalid prompt mode: ${String(promptMode)}`);
    }
    return (input) => (promptMode === undefined ? input : { ...input, promptMode, promptVersion });
}
export async function renderAgentProfile(dependencies, input, promptConfig) {
    if (input.promptProfile === 'desktop' && !input.promptReadContext && promptConfig) {
        const render = (promptReadContext) => renderAgentProfile(dependencies, { ...input, promptReadContext });
        try {
            return await render(await promptConfig.capture());
        }
        catch (error) {
            if (!isPromptSnapshotInvalidError(error))
                throw error;
            return render(await promptConfig.captureBuiltin());
        }
    }
    const context = await dependencies.resolveContext(input);
    return context.canonicalBuiltin
        ? renderBuiltinProfile(dependencies, context)
        : renderCustomProfile(dependencies, context);
}
function assertFrozenPromptSelection(input, definition) {
    if (input.promptMode &&
        definition.promptSnapshot &&
        definition.promptSnapshot.mode !== input.promptMode) {
        throw new Error('The saved Task Prompt does not match --prompt-mode. Start a new Session for this benchmark.');
    }
}
export async function renderFrozenAgentProfile(dependencies, input, definition) {
    assertFrozenPromptSelection(input, definition);
    const exactOwnerName = parseExplicitNameOrStable(input.exactOwnerName);
    const configSelection = frozenConfigSelection(definition);
    const builtin = await frozenBuiltinDefinition(dependencies.catalog, exactOwnerName, definition);
    const canonicalViewName = builtin?.name ?? exactOwnerName;
    const agentRole = builtin?.role ?? 'worker';
    const surface = input.surface ?? 'interactive';
    const capabilities = applyBuiltinSubagentTaskChildCeiling({
        capabilities: resolveCanonicalCapabilities(input.capabilities, builtin?.capabilityOverride),
        canonicalBuiltin: Boolean(builtin),
        canonicalViewName,
        surface,
    });
    const snapshot = definition.promptSnapshot;
    const renderInput = frozenProfileRenderInput(snapshot ? { ...input, promptMode: snapshot.mode } : input, canonicalViewName, surface, capabilities);
    const [surfacePrompt, sharedBase, renderedDefinition] = await Promise.all([
        // Agent-private surface overrides were never part of the saved definition.
        snapshot && canonicalViewName === PRIMARY_AGENT_NAME && surface !== 'task-child'
            ? Promise.resolve('')
            : dependencies.catalog.renderSurfacePrompt(renderInput),
        dependencies.catalog.renderSharedBaseParts(renderInput, agentRole, {
            includeAllLayer: canonicalViewName !== PRIMARY_AGENT_NAME || definition.promptSnapshot === undefined,
        }),
        Promise.resolve(renderFrozenDefinition(dependencies.catalog, renderInput, definition)),
    ]);
    return toFrozenAgentExecutionProfile({
        input,
        definition: renderedDefinition,
        builtin,
        exactOwnerName,
        canonicalViewName,
        agentRole,
        surface,
        capabilities,
        configSelection,
        surfacePrompt,
        sharedBasePrompt: sharedBase.core,
    });
}
function renderFrozenDefinition(catalog, input, definition) {
    if (!definition.promptSnapshot)
        return definition;
    const snapshot = catalog.renderPromptSnapshot(input, definition.promptSnapshot);
    return { ...definition, promptSnapshot: snapshot, systemPrompt: snapshot.systemPrompt };
}
async function frozenBuiltinDefinition(catalog, exactOwnerName, definition) {
    // Custom snapshots always capture an incarnation ID. Only the bundled
    // catalog may classify a snapshot without one; no mutable owner row is read.
    if (definition.ownerInstanceId || !(await catalog.hasBuiltin(exactOwnerName)))
        return undefined;
    return catalog.readDefinition(exactOwnerName);
}
function frozenProfileRenderInput(input, canonicalViewName, surface, capabilities) {
    return withPromptReadContext({
        agentName: canonicalViewName,
        surface,
        ...(input.promptProfile === undefined ? {} : { promptProfile: input.promptProfile }),
        promptMode: input.promptMode,
        promptVersion: input.promptVersion,
        appMode: input.appMode ?? 'coding',
        locale: input.locale ?? resolveLocale(),
        promptChannel: input.promptChannel ?? 'online',
        capabilities,
        memoryEnabled: input.memoryEnabled,
        cronEnabled: input.cronEnabled,
        ...(input.dataDirToken === undefined ? {} : { dataDirToken: input.dataDirToken }),
    }, input);
}
function toFrozenAgentExecutionProfile(input) {
    const { input: request, definition, builtin, exactOwnerName, canonicalViewName, agentRole, surface, capabilities, configSelection, surfacePrompt, sharedBasePrompt, } = input;
    return {
        skipAgentResolution: true,
        ...frozenAgentResourcePolicy(definition, builtin),
        requestRef: normalizeRequestRef(request.requestRef ?? request.exactOwnerName),
        resourceReadRef: exactOwnerName,
        exactOwnerName,
        canonicalViewName,
        resolvedAgentName: exactOwnerName,
        agentRole,
        creationSource: builtin ? 'builtin' : 'manual',
        surface,
        memoryReadAgentNames: frozenMemoryReadAgentNames(builtin),
        agentSystemPrompt: definition.systemPrompt,
        ...(definition.promptSnapshot ? { promptSnapshot: definition.promptSnapshot } : {}),
        corePrompt: [definition.systemPrompt.trim(), sharedBasePrompt.trim()]
            .filter(Boolean)
            .join('\n\n'),
        surfacePrompt,
        capabilityCeiling: toCapabilityCeiling(capabilities),
        configSelection,
        provenance: frozenProfileProvenance(request, builtin, canonicalViewName),
    };
}
function frozenAgentResourcePolicy(definition, builtin) {
    if (definition.ownerInstanceId)
        return { expectedAgentInstanceId: definition.ownerInstanceId };
    return builtin ? {} : { excludeAgentResources: true };
}
function frozenMemoryReadAgentNames(builtin) {
    return builtin?.name === PRIMARY_AGENT_NAME ? [PRIMARY_AGENT_NAME] : NO_AGENT_MEMORY;
}
function frozenProfileProvenance(input, builtin, canonicalViewName) {
    return {
        source: builtin ? 'builtin' : 'custom',
        assetAgentName: canonicalViewName,
        locale: input.locale ?? resolveLocale(),
        appMode: input.appMode ?? 'coding',
        promptChannel: input.promptChannel ?? 'online',
    };
}
export async function readBuiltinAgentContent(catalog, view, canonicalName, definition) {
    const content = await catalog.readCanonicalContent({
        agentName: canonicalName,
        surface: 'interactive',
        appMode: 'coding',
        locale: resolveLocale(),
        promptChannel: 'online',
        capabilities: resolveCanonicalCapabilities(undefined, definition.capabilityOverride),
    });
    return {
        ...view,
        ...(content.persona === undefined ? {} : { persona: content.persona }),
        ...(content.systemPrompt === undefined ? {} : { systemPrompt: content.systemPrompt }),
    };
}
async function renderBuiltinProfile(dependencies, context) {
    const renderInput = withPromptReadContext(toBuiltinRenderInput(context, resolveLocale), context.input);
    const read = dependencies.repository.getBuiltinCanonicalConfig;
    if (!read) {
        throw new AgentServiceError('AGENT_CONFIG_NOT_FOUND', 'Canonical Built-in Agent configuration storage is unavailable.');
    }
    let managed;
    try {
        managed = await read.call(dependencies.repository, context.canonicalViewName);
    }
    catch (error) {
        throw asAgentConfigServiceError(error);
    }
    const rendered = await dependencies.catalog.render(renderInput, managed.systemPrompt);
    return {
        ...toBuiltinProfile(context, rendered, resolveLocale, toCapabilityCeiling),
        agentSystemPrompt: rendered.agentSystemPrompt,
        configSelection: toConfigSelection(managed),
    };
}
async function renderCustomProfile(dependencies, context) {
    const renderInput = withPromptReadContext(toBuiltinRenderInput(context, resolveLocale), context.input);
    const [canonical, surfacePrompt, sharedBasePrompt] = await Promise.all([
        readCanonicalAgentConfig(dependencies.repository, context.meta.name),
        dependencies.catalog.renderSurfacePrompt({
            agentName: context.exactOwnerName,
            surface: context.surface,
            ...(context.input.promptProfile === undefined
                ? {}
                : { promptProfile: context.input.promptProfile }),
            promptMode: context.input.promptMode,
            promptVersion: context.input.promptVersion,
            appMode: context.input.appMode ?? 'coding',
            locale: context.input.locale ?? resolveLocale(),
            promptChannel: context.input.promptChannel ?? 'online',
            capabilities: context.capabilities,
            memoryEnabled: context.input.memoryEnabled,
            cronEnabled: context.input.cronEnabled,
            dataDirToken: context.input.dataDirToken,
            agentConfigDir: dependencies.repository.getAgentDir(context.exactOwnerName),
            ...(context.input.promptReadContext === undefined
                ? {}
                : { promptReadContext: context.input.promptReadContext }),
        }),
        dependencies.catalog.renderSharedBasePrompt(renderInput, context.executionMeta.agentRole),
    ]);
    return {
        requestRef: context.requestRef,
        resourceReadRef: toAgentRequestRef({
            name: context.exactOwnerName,
            creationSource: context.meta.creationSource,
        }) ?? context.exactOwnerName,
        exactOwnerName: context.exactOwnerName,
        canonicalViewName: context.canonicalViewName,
        resolvedAgentName: context.resolvedAgentName,
        agentRole: context.executionMeta.agentRole,
        creationSource: context.meta.creationSource,
        surface: context.surface,
        memoryReadAgentNames: context.memoryReadAgentNames,
        agentSystemPrompt: canonical.systemPrompt,
        corePrompt: [canonical.systemPrompt.trim(), sharedBasePrompt.trim()]
            .filter(Boolean)
            .join('\n\n'),
        surfacePrompt,
        capabilityCeiling: toCapabilityCeiling(context.capabilities),
        configSelection: toConfigSelection(canonical),
        provenance: {
            source: 'custom',
            assetAgentName: context.meta.name,
            locale: context.input.locale ?? resolveLocale(),
        },
    };
}
function withPromptReadContext(input, request) {
    return request.promptReadContext === undefined
        ? input
        : { ...input, promptReadContext: request.promptReadContext };
}
export async function readCanonicalAgentConfig(repository, name) {
    if (!repository.getCanonicalConfig) {
        throw new AgentServiceError('AGENT_CONFIG_NOT_FOUND', 'Canonical Agent configuration storage is unavailable.');
    }
    try {
        return await repository.getCanonicalConfig(name);
    }
    catch (error) {
        throw asAgentConfigServiceError(error);
    }
}
/** Safe Custom-avatar read shared by profile-facing Desktop transport only. */
export async function readCanonicalCustomAvatar(repository, name) {
    if (!repository.readCustomAvatar) {
        throw new AgentServiceError('CANONICAL_AGENT_NOT_AVAILABLE', 'Canonical Custom Agent avatar storage is unavailable.');
    }
    try {
        return await repository.readCustomAvatar(name);
    }
    catch (error) {
        throw asAgentConfigServiceError(error);
    }
}
function toConfigSelection(config) {
    return {
        ...(config.model ? { model: config.model } : {}),
        ...(config.effort ? { effort: config.effort } : {}),
        ...(config.xMavis?.contextWindow === undefined
            ? {}
            : { contextWindow: config.xMavis.contextWindow }),
        ...(config.xMavis?.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: config.xMavis.maxOutputTokens }),
        ...(config.tools === undefined ? {} : { tools: config.tools }),
        ...(config.disallowedTools === undefined ? {} : { disallowedTools: config.disallowedTools }),
        ...(config.mcpServers === undefined ? {} : { mcpServers: config.mcpServers }),
        ...(config.skills === undefined ? {} : { skills: config.skills }),
        ...(config.xMavis?.extensionSkills === undefined
            ? {}
            : { extensionSkills: config.xMavis.extensionSkills }),
    };
}
function frozenConfigSelection(definition) {
    if (typeof definition.systemPrompt !== 'string') {
        throw new AgentServiceError('AGENT_CONFIG_INVALID', 'Frozen Agent definition systemPrompt must be a string.', undefined, { field: 'definition.systemPrompt', reason: 'must be a string' });
    }
    const capabilities = definition.capabilities;
    if (!capabilities || typeof capabilities !== 'object') {
        throw new AgentServiceError('AGENT_CONFIG_INVALID', 'Frozen Agent definition capabilities must be an object.', undefined, { field: 'definition.capabilities', reason: 'must be an object' });
    }
    return {
        ...copyFrozenSelector(capabilities, 'tools'),
        ...copyFrozenSelector(capabilities, 'disallowedTools'),
        ...copyFrozenSelector(capabilities, 'mcpServers'),
        ...copyFrozenSelector(capabilities, 'skills'),
        ...copyFrozenSelector(capabilities, 'extensionSkills'),
    };
}
function copyFrozenSelector(capabilities, key) {
    const value = capabilities[key];
    if (value === undefined)
        return {};
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new AgentServiceError('AGENT_CONFIG_INVALID', `Frozen Agent definition ${key} must be a string array.`, undefined, { field: `definition.capabilities.${key}`, reason: 'must be a string array' });
    }
    return { [key]: [...value] };
}
export function asAgentConfigServiceError(error) {
    if (!(error instanceof AgentConfigError))
        return error instanceof Error ? error : new Error(String(error));
    return new AgentServiceError(error.code, `Agent configuration ${error.field}: ${error.message}`, undefined, { field: error.field, reason: error.message });
}
//# sourceMappingURL=agent-profile.js.map