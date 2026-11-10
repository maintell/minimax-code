import {} from '@mavis/skills';
import { readConfiguredSkillRoots } from './roots.js';
import { deleteRegistrySkill, getRegistrySkillDetail, hasRegistryLocationUri, inferAgentNameFromConfiguredLocationUri, listRegistryRuntimeSkills, listRegistrySkillFiles, listRegistrySkillSummaries, readRegistrySkillByName, readRegistrySkillFile, resolveRegistrySkillIdentity, renderLocalRegistrySkillsCatalog, } from './registry-operations.js';
import { createRegistryHandle, inheritedRuntimeReadBetaFlags, normalizeAgentName, } from './registry-handle.js';
import { createAgentResourceScopeReader } from './registry-agent-scope.js';
// The provider is process-scoped while workspace roots are session-scoped.
// Keep recent registries warm without retaining every historical session.
const MAX_CACHED_REGISTRY_HANDLES = 16;
export function createLocalSkillRegistryProvider(configGetter, rootsGetter, diagnosticSink, ports = {}) {
    const { enabledState = createProcessLocalSkillEnabledState(), readMcpServerNames = async () => new Set(), } = ports;
    const handles = new Map();
    const emitDiagnostic = (event) => {
        try {
            diagnosticSink?.(event);
        }
        catch {
            // Diagnostics are explicitly fail-open and never alter Skill behavior.
        }
    };
    function cacheHandle(rootsKey, handle) {
        handles.delete(rootsKey);
        handles.set(rootsKey, handle);
        while (handles.size > MAX_CACHED_REGISTRY_HANDLES) {
            const oldest = handles.entries().next().value;
            if (!oldest)
                return;
            const [oldestKey, oldestHandle] = oldest;
            handles.delete(oldestKey);
            const startedAtMs = Date.now();
            emitDiagnostic({
                type: 'skill_registry_lru_close_begin',
                registryCacheCount: handles.size,
            });
            oldestHandle.close();
            emitDiagnostic({
                type: 'skill_registry_lru_close_end',
                registryCacheCount: handles.size,
                durationMs: Math.max(0, Date.now() - startedAtMs),
            });
        }
    }
    async function getHandleForAgent(scope = {}) {
        const { agentName, workspaceDir, compatibleAgentNames, excludeAgentResources = false, expectedAgentInstanceId, } = scope;
        const resolvedAgentName = normalizeAgentName(agentName);
        const configuredRoots = rootsGetter?.(resolvedAgentName, workspaceDir, compatibleAgentNames) ??
            readConfiguredSkillRoots(configGetter(), resolvedAgentName, workspaceDir, compatibleAgentNames);
        const roots = excludeAgentResources
            ? configuredRoots.filter((root) => root.kind !== 'agent' && !(root.kind === 'builtin' && root.scope))
            : configuredRoots;
        const rootsKey = JSON.stringify([expectedAgentInstanceId, roots]);
        let handle = handles.get(rootsKey);
        if (!handle) {
            handle = createRegistryHandle(roots);
        }
        cacheHandle(rootsKey, handle);
        return handle;
    }
    async function getHandleForLocationUri(locationUri) {
        for (const [rootsKey, handle] of [...handles.entries()]) {
            const registry = await handle.registryPromise;
            if (hasRegistryLocationUri(registry, locationUri)) {
                if (handles.get(rootsKey) === handle)
                    cacheHandle(rootsKey, handle);
                return handle;
            }
        }
        const defaultHandle = await getHandleForAgent(undefined);
        const defaultRegistry = await defaultHandle.registryPromise;
        if (hasRegistryLocationUri(defaultRegistry, locationUri))
            return defaultHandle;
        const agentName = rootsGetter
            ? undefined
            : await inferAgentNameFromConfiguredLocationUri(configGetter(), locationUri);
        if (!agentName)
            return undefined;
        const agentHandle = await getHandleForAgent({ agentName });
        const agentRegistry = await agentHandle.registryPromise;
        return hasRegistryLocationUri(agentRegistry, locationUri) ? agentHandle : undefined;
    }
    async function resolveSkillHandle(input) {
        if (input.locationUri && !input.excludeAgentResources && !input.expectedAgentInstanceId) {
            return getHandleForLocationUri(input.locationUri);
        }
        const handle = await getHandleForAgent(input);
        if (input.locationUri &&
            !hasRegistryLocationUri(await handle.registryPromise, input.locationUri)) {
            return undefined;
        }
        return handle;
    }
    const withAgentResourceScope = createAgentResourceScopeReader(() => configGetter().dataDir);
    async function refreshHandle(handle) {
        if (!handle.refreshPromise) {
            handle.refreshPromise = (async () => {
                try {
                    const registry = await handle.registryPromise;
                    await registry.refresh();
                    handle.restartWatcher();
                }
                finally {
                    handle.refreshPromise = undefined;
                }
            })();
        }
        return handle.refreshPromise;
    }
    async function refreshCachedHandles() {
        // Shared roots must publish mutations to every warm workspace/Agent view,
        // including remote hosts where recursive watching is unavailable.
        await Promise.all([...handles.values()].map(refreshHandle));
    }
    return {
        ...createRegistryOperations({
            getHandleForAgent,
            withAgentResourceScope,
            resolveSkillHandle,
            refreshCachedHandles,
            enabledState,
            readMcpServerNames,
        }),
        close: () => {
            for (const handle of handles.values())
                handle.close();
            handles.clear();
        },
    };
}
function createRegistryOperations(context) {
    const { getHandleForAgent, withAgentResourceScope, resolveSkillHandle, refreshCachedHandles, enabledState, readMcpServerNames, } = context;
    return {
        async listSkills(input, installedHubMetadataByLocationUri) {
            return withAgentResourceScope(input, async (scopedInput) => {
                const agentName = normalizeAgentName(scopedInput.agentName);
                const handle = await getHandleForAgent(scopedInput);
                const registry = await handle.registryPromise;
                const disabledLocationUris = await enabledState.getDisabledLocationUris();
                return listRegistrySkillSummaries(registry, {
                    limit: scopedInput.limit,
                    cursor: scopedInput.cursor,
                    scope: scopedInput.scope,
                    sourceType: scopedInput.sourceType,
                    keyword: scopedInput.keyword,
                    excludeBuiltin: scopedInput.excludeBuiltin,
                    agentName,
                    compatibleAgentNames: scopedInput.compatibleAgentNames,
                    installedHubMetadataByLocationUri,
                    disabledLocationUris,
                    betaFlags: scopedInput.betaFlags,
                });
            });
        },
        async listRuntimeSkills(input = {}) {
            return withAgentResourceScope(input, async (scopedInput) => {
                const agentName = normalizeAgentName(scopedInput.agentName);
                const handle = await getHandleForAgent(scopedInput);
                const registry = await handle.registryPromise;
                const [mcpServerNames, disabledLocationUris] = await Promise.all([
                    readMcpServerNames(),
                    enabledState.getDisabledLocationUris(),
                ]);
                return listRegistryRuntimeSkills(registry, {
                    agentName,
                    compatibleAgentNames: scopedInput.compatibleAgentNames,
                    betaFlags: scopedInput.betaFlags,
                    injectableBuiltinSkillNames: scopedInput.injectableBuiltinSkillNames,
                    allowedSkillNames: scopedInput.allowedSkillNames,
                    allowedExtensionSkillNames: scopedInput.allowedExtensionSkillNames,
                    mcpServerNames,
                    disabledLocationUris,
                });
            });
        },
        async renderCatalog(input = {}) {
            return withAgentResourceScope(input, async (scopedInput) => {
                const agentName = normalizeAgentName(scopedInput.agentName);
                const handle = await getHandleForAgent(scopedInput);
                const registry = await handle.registryPromise;
                const [mcpServerNames, disabledLocationUris] = await Promise.all([
                    readMcpServerNames(),
                    enabledState.getDisabledLocationUris(),
                ]);
                return renderLocalRegistrySkillsCatalog(registry, {
                    agentName,
                    compatibleAgentNames: scopedInput.compatibleAgentNames,
                    injectableBuiltinSkillNames: scopedInput.injectableBuiltinSkillNames,
                    allowedSkillNames: scopedInput.allowedSkillNames,
                    allowedExtensionSkillNames: scopedInput.allowedExtensionSkillNames,
                    betaFlags: scopedInput.betaFlags,
                    mcpServerNames,
                    disabledLocationUris,
                    contextWindowTokens: scopedInput.contextWindowTokens,
                    additionalSkills: scopedInput.additionalSkills,
                });
            });
        },
        async readSkillByName(name, options = {}) {
            return withAgentResourceScope(options, async (scopedOptions) => {
                const agentName = normalizeAgentName(scopedOptions.agentName);
                const handle = await getHandleForAgent(scopedOptions);
                const registry = await handle.registryPromise;
                const [mcpServerNames, disabledLocationUris] = await Promise.all([
                    readMcpServerNames(),
                    enabledState.getDisabledLocationUris(),
                ]);
                const skill = readRegistrySkillByName(registry, name, {
                    agentName,
                    compatibleAgentNames: scopedOptions.compatibleAgentNames,
                    resourceAmbiguityTelemetry: scopedOptions.resourceAmbiguityTelemetry,
                    disabledLocationUris,
                    betaFlags: scopedOptions.betaFlags ?? inheritedRuntimeReadBetaFlags(registry),
                    injectableBuiltinSkillNames: scopedOptions.injectableBuiltinSkillNames,
                    allowedSkillNames: scopedOptions.allowedSkillNames,
                    allowedExtensionSkillNames: scopedOptions.allowedExtensionSkillNames,
                    mcpServerNames,
                });
                return skill;
            });
        },
        async getSkillDetail(input, options = {}) {
            return withAgentResourceScope(input, async (scopedInput) => {
                const handle = await resolveSkillHandle(scopedInput);
                if (!handle)
                    return undefined;
                const registry = await handle.registryPromise;
                return getRegistrySkillDetail(registry, scopedInput, {
                    ...options,
                    disabledLocationUris: await enabledState.getDisabledLocationUris(),
                });
            });
        },
        async listSkillFiles(input) {
            return withAgentResourceScope(input, async (scopedInput) => {
                const handle = await resolveSkillHandle(scopedInput);
                if (!handle)
                    return undefined;
                const registry = await handle.registryPromise;
                return listRegistrySkillFiles(registry, scopedInput);
            });
        },
        async readSkillFile(input) {
            return withAgentResourceScope(input, async (scopedInput) => {
                const handle = await resolveSkillHandle(scopedInput);
                if (!handle)
                    return undefined;
                const registry = await handle.registryPromise;
                return readRegistrySkillFile(registry, scopedInput);
            });
        },
        async deleteSkill(input) {
            const handle = await resolveSkillHandle(input);
            if (!handle)
                return undefined;
            const registry = await handle.registryPromise;
            const identity = resolveRegistrySkillIdentity(registry, input);
            const deleted = await deleteRegistrySkill(registry, input);
            if (deleted && deleted !== 'protected') {
                if (identity)
                    await enabledState.forget(identity.locationUri);
                await refreshCachedHandles();
            }
            return deleted;
        },
        async setSkillEnabled(input, enabled) {
            const handle = await resolveSkillHandle(input);
            if (!handle)
                return undefined;
            const registry = await handle.registryPromise;
            const identity = resolveRegistrySkillIdentity(registry, input);
            if (!identity)
                return undefined;
            await enabledState.setEnabled(identity.locationUri, enabled);
            return { ok: true, name: identity.name, enabled };
        },
        async refresh(input = {}) {
            await getHandleForAgent(input);
            await refreshCachedHandles();
        },
    };
}
function createProcessLocalSkillEnabledState() {
    const disabled = new Set();
    return {
        getDisabledLocationUris: async () => new Set(disabled),
        setEnabled: async (locationUri, enabled) => {
            if (enabled)
                disabled.delete(locationUri);
            else
                disabled.add(locationUri);
        },
        forget: async (locationUri) => {
            disabled.delete(locationUri);
        },
    };
}
//# sourceMappingURL=registry.js.map