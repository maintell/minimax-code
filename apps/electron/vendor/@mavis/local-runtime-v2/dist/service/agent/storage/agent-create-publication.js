import { eq } from 'drizzle-orm';
import { agents } from '../../../infra/db/schema/agents.js';
import { AgentFiles } from './agent-files.js';
import { AgentConfigError, } from './canonical-agent-config.js';
export function canonicalConfigForInsert(input, canonicalAvatar) {
    if (input.initialDefinition !== undefined) {
        return canonicalConfigForInitialDefinition(input, canonicalAvatar);
    }
    const displayName = input.displayName?.trim();
    const avatar = canonicalAvatar?.trim();
    const defaultWorkspaceDir = input.defaultWorkspaceDir?.trim();
    const xMavis = {
        ...(displayName ? { displayName } : {}),
        ...(avatar ? { avatar } : {}),
        ...(defaultWorkspaceDir ? { defaultWorkspaceDir } : {}),
    };
    return {
        name: input.name,
        description: input.description?.trim() || displayName || input.name,
        ...(Object.keys(xMavis).length > 0 ? { xMavis } : {}),
        systemPrompt: mergeLegacyPrompt(input.persona, input.systemPrompt),
    };
}
export async function discardInitialCustomConfig(input) {
    const removed = await input.files.withLock(input.name, async () => {
        const removedConfig = await input.files.removeCanonicalConfigIfUnchanged(input.name, input.publication.config, true);
        if (!removedConfig)
            return false;
        if (input.publication.avatar?.staged) {
            await input.files.removeStagedCustomAvatarIfUnchanged(input.name, input.publication.avatar.staged, true);
        }
        await input.files.removeCustomAgentInstanceIdIfUnchanged(input.name, input.publication.instanceId, true);
        return true;
    });
    if (!removed) {
        throw new AgentConfigError('AGENT_CONFIG_INVALID', 'agent.md', 'Custom Agent configuration changed before atomic create rollback.');
    }
    input.db.delete(agents).where(eq(agents.agentName, input.name)).run();
}
export function unsupportedCustomLegacyAsset(field) {
    return new AgentConfigError('AGENT_CONFIG_INVALID', field, `Custom Agent ${field} must be edited in canonical agent.md.`);
}
export function runtimeStateUnavailable() {
    return new AgentConfigError('AGENT_CONFIG_INVALID', 'runtime_state', 'Custom Agent configuration was published but runtime state is unavailable.');
}
export function isConfigNotFound(error) {
    return error instanceof AgentConfigError && error.code === 'AGENT_CONFIG_NOT_FOUND';
}
function canonicalConfigForInitialDefinition(input, canonicalAvatar) {
    const definition = initialDefinitionForInsert(input);
    const xMavis = canonicalMavisForInitialDefinition(input, canonicalAvatar);
    return {
        name: input.name,
        description: definition.description.trim().length > 0
            ? definition.description
            : input.displayName?.trim() || input.name,
        ...canonicalInitialDefinitionFields(definition),
        ...(Object.keys(xMavis).length === 0 ? {} : { xMavis }),
        systemPrompt: definition.systemPrompt,
    };
}
function initialDefinitionForInsert(input) {
    if (input.initialDefinition === undefined)
        throw new Error('Initial definition is required.');
    return input.initialDefinition;
}
function canonicalInitialDefinitionFields(input) {
    return {
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
        ...(input.disallowedTools === undefined ? {} : { disallowedTools: [...input.disallowedTools] }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: [...input.mcpServers] }),
        ...(input.skills === undefined ? {} : { skills: [...input.skills] }),
    };
}
function canonicalMavisForInitialDefinition(input, canonicalAvatar) {
    const mavis = initialDefinitionForInsert(input).mavis;
    return {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(canonicalAvatar === undefined ? {} : { avatar: canonicalAvatar }),
        ...(mavis?.contextWindow === undefined ? {} : { contextWindow: mavis.contextWindow }),
        ...(mavis?.maxOutputTokens === undefined ? {} : { maxOutputTokens: mavis.maxOutputTokens }),
        ...(input.defaultWorkspaceDir === undefined
            ? {}
            : { defaultWorkspaceDir: input.defaultWorkspaceDir }),
        ...(mavis?.extensionSkills === undefined
            ? {}
            : { extensionSkills: [...mavis.extensionSkills] }),
    };
}
export function mergeLegacyPrompt(persona, systemPrompt) {
    const personaBody = persona?.trim();
    const promptBody = systemPrompt?.trim();
    if (!personaBody)
        return promptBody ?? '';
    return [personaBody, promptBody].filter(Boolean).join('\n\n');
}
//# sourceMappingURL=agent-create-publication.js.map