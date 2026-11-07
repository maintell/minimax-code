import { BuiltinAgentCatalog, resolveCanonicalCapabilities, } from '../../builtin/catalog.js';
import { LEGACY_PRIMARY_AGENT_NAME } from '../../domain/names.js';
import { AgentConfigError } from '../../storage/canonical-agent-config.js';
import { BuiltinAgentConfigRepairError } from '../../storage/builtin-agent-files.js';
import { resolveLocale } from '../../domain/validation.js';
export async function rebuildBuiltinCanonicalFiles(input) {
    await removeRetiredLegacyPrimaryBuiltinFile(input.repository);
    if (!input.repository.writeBuiltinCanonicalConfig)
        return;
    for (const definition of input.definitions) {
        // This runs inside the synchronous startup barrier. One Builtin file that
        // cannot be read, reloaded, archived or rewritten must not fail the whole
        // local runtime. A failed reload leaves the valid old file in use; an
        // unusable file reports a copyable repair instruction when the Agent is
        // used (see renderBuiltinProfile).
        const progress = { stage: 'read' };
        try {
            await rebuildBuiltinCanonicalFile(input, definition, progress);
        }
        catch (error) {
            emitBuiltinAgentConfigRepair(input.report, {
                kind: 'repair_failed',
                agentName: definition.name,
                errorCode: repairFailureCode(error),
                stage: progress.stage,
            });
        }
    }
}
/** `main` is only a compatibility owner; its old launch file cannot execute. */
async function removeRetiredLegacyPrimaryBuiltinFile(repository) {
    await repository.removeBuiltinCanonicalConfig?.(LEGACY_PRIMARY_AGENT_NAME);
}
async function rebuildBuiltinCanonicalFile(input, definition, progress) {
    const capabilities = resolveCanonicalCapabilities(undefined, definition.capabilityOverride);
    const existing = await inspectExistingBuiltinConfig(input.repository, definition.name);
    if (existing.kind === 'valid') {
        progress.stage = 'reload';
        await reloadBuiltinCanonicalFile(input, definition, capabilities);
        return;
    }
    // Build the bundled baseline before touching a corrupted file, so a missing
    // template never leaves an archive behind without a replacement.
    progress.stage = 'template';
    const { config } = await buildBuiltinFactoryConfig(input, definition, capabilities);
    if (existing.kind === 'missing') {
        progress.stage = 'seed';
        await input.repository.writeBuiltinCanonicalConfig?.(definition.name, config);
        return;
    }
    await repairCorruptedBuiltinCanonicalFile(input, { agentName: definition.name, corruption: existing.error, config }, progress);
}
/**
 * Use-time counterpart of the startup "seed when missing" step. Another
 * process sharing the data directory (old `@minimax-ai/code` ACP clients)
 * deletes `.builtin/<name>/agent.md` while this runtime is running, and
 * startup is the only other place that recreates it. This writes the same
 * bundled template with the same freshly resolved model group, and only when
 * the file is still absent: the `.builtin:<name>` lock plus publish-if-absent
 * keep an existing file untouched and let concurrent Turns write it once.
 */
export async function reseedMissingBuiltinCanonicalFile(input) {
    const { definition, repository } = input;
    if (!repository.writeBuiltinCanonicalConfig)
        return;
    const capabilities = resolveCanonicalCapabilities(undefined, definition.capabilityOverride);
    const { config } = await buildBuiltinFactoryConfig(input, definition, capabilities);
    const outcome = await repository.writeBuiltinCanonicalConfig(definition.name, config);
    if (outcome === 'already-exists')
        return;
    emitBuiltinAgentConfigRepair(input.report, {
        kind: 'reseeded',
        agentName: definition.name,
        trigger: 'use_time',
    });
}
/**
 * The current bundled content of one Builtin file: the raw V2 template plus
 * the resolved model group. A missing file passes no previous group; a reload
 * passes the existing file's group so the resolver keeps it when still usable.
 */
async function buildBuiltinFactoryConfig(input, definition, capabilities, previous) {
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
        previous,
        resolver: input.modelGroupResolver,
        bundled: input.bundledModelGroup,
    });
    return {
        config: toBuiltinCanonicalConfig(definition, modelGroup, capabilities, content),
        modelGroup,
    };
}
/**
 * Rule for Builtin files: at runtime the local `agent.md` is the source of
 * truth (an edit applies from the next Turn), and every startup reloads it to
 * the current version's bundled content, keeping only the model group
 * (`model`, `effort`, `x-mavis.contextWindow`, `x-mavis.maxOutputTokens`).
 * The model group is the one part of a Builtin Agent the product lets users
 * change (UI `canEditConfigField` in AgentManagementPage.tsx, runtime
 * `assertBuiltinConfigModelOnlyUpdate`); everything else is bundled content
 * that must follow the installed version. The file is overwritten in place
 * without an archive, only when its bytes would change, and only if it still
 * has the revision read here.
 */
async function reloadBuiltinCanonicalFile(input, definition, capabilities) {
    const { repository } = input;
    if (!repository.readCanonicalDocument || !repository.rewriteBuiltinCanonicalConfig)
        return;
    const document = await repository.readCanonicalDocument(definition.name, true);
    const previous = modelGroupFromCanonical(document.config);
    const { config, modelGroup } = await buildBuiltinFactoryConfig(input, definition, capabilities, previous);
    const outcome = await repository.rewriteBuiltinCanonicalConfig(definition.name, config, document.revision);
    if (outcome !== 'rewritten')
        return;
    emitBuiltinAgentConfigRepair(input.report, {
        kind: 'reloaded',
        agentName: definition.name,
        modelKept: previous?.model === modelGroup?.model,
    });
}
/**
 * A corrupted Builtin source is archived byte-for-byte and then rewritten from
 * the bundled template. The archive keeps the user's edits recoverable, which
 * is what used to justify failing startup on an invalid file. The repository
 * re-checks the file under its lock and skips one that was fixed or deleted
 * while the template and model group were loading.
 */
async function repairCorruptedBuiltinCanonicalFile(input, repair, progress) {
    const { agentName, corruption, config } = repair;
    progress.stage = 'archive';
    if (!input.repository.replaceCorruptedBuiltinCanonicalConfig)
        throw corruption;
    let result;
    try {
        result = await input.repository.replaceCorruptedBuiltinCanonicalConfig(agentName, config);
    }
    catch (error) {
        if (!(error instanceof BuiltinAgentConfigRepairError))
            throw error;
        progress.stage = error.stage;
        if (error.archiveFile) {
            emitBuiltinAgentConfigRepair(input.report, {
                kind: 'archived',
                agentName,
                errorCode: corruption.code,
                archiveFile: error.archiveFile,
            });
        }
        throw error.failure;
    }
    if ('skipped' in result) {
        emitBuiltinAgentConfigRepair(input.report, {
            kind: 'repair_skipped',
            agentName,
            errorCode: corruption.code,
            reason: result.skipped,
        });
        return;
    }
    emitBuiltinAgentConfigRepair(input.report, {
        kind: 'archived',
        agentName,
        errorCode: corruption.code,
        archiveFile: result.archiveFile,
    });
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
async function inspectExistingBuiltinConfig(repository, name) {
    if (!repository.getBuiltinCanonicalConfig)
        return { kind: 'missing' };
    try {
        await repository.getBuiltinCanonicalConfig(name);
        return { kind: 'valid' };
    }
    catch (error) {
        if (!(error instanceof AgentConfigError))
            throw error;
        if (error.code === 'AGENT_CONFIG_NOT_FOUND')
            return { kind: 'missing' };
        return {
            kind: 'corrupted',
            error: error,
        };
    }
}
function emitBuiltinAgentConfigRepair(report, event) {
    try {
        report?.(event);
    }
    catch {
        // Observability must never change startup recovery.
    }
}
/** A stable code only: error messages may embed the user's dataDir path. */
function repairFailureCode(error) {
    const code = error?.code;
    if (typeof code === 'string' && code)
        return code;
    if (error instanceof Error && error.name !== 'Error')
        return error.name;
    return 'unknown';
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
    if (input.resolver) {
        return input.resolver({
            ...(input.previous ? { previous: input.previous } : {}),
            bundled: input.bundled,
        });
    }
    // The first startup pass runs before the Model System binds a resolver. Keep
    // the previous group verbatim so a crash before the second pass loses no
    // user model choice; the second pass resolves it against the live catalog.
    return input.previous;
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