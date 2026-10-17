import { isTrustedBuiltinCreationSource, toAgentRequestRef, } from '@mavis/agent-tools/desktop/subagent-roles';
import { resolveCanonicalCapabilities, } from '../../builtin/catalog.js';
export function toBuiltinRenderInput(context, resolveLocale) {
    const { input } = context;
    return {
        agentName: context.canonicalViewName,
        surface: context.surface,
        ...(input.promptProfile === undefined ? {} : { promptProfile: input.promptProfile }),
        promptMode: input.promptMode,
        promptVersion: input.promptVersion,
        appMode: input.appMode ?? 'coding',
        locale: input.locale ?? resolveLocale(),
        promptChannel: input.promptChannel ?? 'online',
        capabilities: context.capabilities,
        memoryEnabled: input.memoryEnabled,
        cronEnabled: input.cronEnabled,
        ...(input.dataDirToken === undefined ? {} : { dataDirToken: input.dataDirToken }),
    };
}
export function toBuiltinProfile(context, rendered, resolveLocale, toCapabilityCeiling) {
    const { input, capabilities } = context;
    return {
        requestRef: context.requestRef,
        resourceReadRef: toAgentRequestRef({
            name: context.canonicalViewName,
            creationSource: 'builtin',
        }) ?? context.exactOwnerName,
        exactOwnerName: context.exactOwnerName,
        canonicalViewName: context.canonicalViewName,
        resolvedAgentName: context.resolvedAgentName,
        agentRole: context.executionMeta.agentRole,
        creationSource: context.meta.creationSource,
        surface: context.surface,
        memoryReadAgentNames: context.memoryReadAgentNames,
        ...(rendered.persona && capabilities.persona.enabled ? { persona: rendered.persona } : {}),
        ...(rendered.promptSnapshot ? { promptSnapshot: rendered.promptSnapshot } : {}),
        corePrompt: rendered.corePrompt,
        surfacePrompt: rendered.surfacePrompt,
        capabilityCeiling: toCapabilityCeiling(capabilities),
        provenance: {
            source: context.exactOwnerName !== context.canonicalViewName ? 'legacy-read-through' : 'builtin',
            assetAgentName: rendered.assetAgentName,
            locale: input.locale ?? resolveLocale(),
            appMode: input.appMode ?? 'coding',
            promptChannel: input.promptChannel ?? 'online',
        },
    };
}
export async function readAgentViewReferences(repository, meta, canonical, exactOwnerName) {
    const [identity, config] = await Promise.all([
        repository.getIdentity(meta.name),
        repository.getConfig(meta.name),
    ]);
    const canonicalOwner = isTrustedBuiltinCreationSource(meta.creationSource) && canonical !== exactOwnerName
        ? await repository.get(canonical)
        : undefined;
    return { identity, config, canonicalOwner };
}
function toAgentViewOptionalFields(input) {
    const { meta, canonical, exactOwnerName, identity, config, definition, builtin } = input;
    return {
        ...(meta.rootSessionId ? { rootSessionId: meta.rootSessionId } : {}),
        ...toOptionalTextField('description', identity?.description ?? definition?.identity.description),
        ...toOptionalTextField('avatar', identity?.avatar ?? definition?.identity.avatar),
        ...(config?.defaultWorkspaceDir ? { defaultWorkspaceDir: config.defaultWorkspaceDir } : {}),
        ...(builtin && exactOwnerName !== canonical ? { legacySourceName: exactOwnerName } : {}),
    };
}
/** Pure V2 Agent response projection. */
export function toAgentView(input) {
    const { meta, canonical, exactOwnerName, resolvedAgentName, identity, config, definition, builtin, primary, primaryDisplayName, agentConfigDir, } = input;
    const viewName = builtin ? canonical : exactOwnerName;
    const displayName = primary && primaryDisplayName
        ? primaryDisplayName
        : (identity?.displayName ?? definition?.identity.displayName ?? viewName);
    const requestRef = toAgentRequestRef({
        name: exactOwnerName,
        creationSource: builtin ? 'builtin' : meta.creationSource,
    }) ?? exactOwnerName;
    return {
        name: viewName,
        requestRef: builtin ? canonical : requestRef,
        canonicalViewName: canonical,
        exactOwnerName,
        resolvedAgentName,
        agentRole: meta.agentRole,
        creationSource: meta.creationSource,
        agentConfigDir,
        displayName,
        createdAtMs: meta.createdAtMs,
        updatedAtMs: meta.updatedAtMs,
        ...toAgentViewOptionalFields({
            meta,
            canonical,
            exactOwnerName,
            identity,
            config,
            definition,
            builtin,
        }),
    };
}
function toOptionalTextField(key, value) {
    return value ? { [key]: value } : {};
}
//# sourceMappingURL=view.js.map