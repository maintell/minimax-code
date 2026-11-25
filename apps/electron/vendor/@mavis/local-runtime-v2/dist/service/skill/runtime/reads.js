import { toNormalizedSkillSelectorSet } from '../registry/registry-family.js';
export function createRuntimeSkillReads(deps, registryProvider) {
    const resolveReadScope = async (requestedName, skipAgentResolution = false) => {
        const requested = normalizeAgentName(requestedName);
        if (skipAgentResolution || !deps.resolveAgentReadScope) {
            return { canonicalName: requested, compatibleNames: [requested] };
        }
        const resolved = await deps.resolveAgentReadScope(requested);
        const canonicalName = resolved.canonicalName.trim() || requested;
        const compatibleNames = [canonicalName, ...(resolved.compatibleNames ?? [])].filter((name, index, names) => name.trim().length > 0 &&
            names.findIndex((candidate) => candidate.trim() === name.trim()) === index);
        return { canonicalName, compatibleNames };
    };
    const betaFlags = () => ({
        ...(deps.configGetter().beta ?? {}),
    });
    return {
        async listRuntimeSkills(scope = {}) {
            const readScope = await resolveReadScope(scope.agentName, scope.excludeAgentResources ||
                scope.skipAgentResolution ||
                Boolean(scope.expectedAgentInstanceId));
            return registryProvider.listRuntimeSkills({
                agentName: readScope.canonicalName,
                ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
                workspaceDir: scope.workspaceDir,
                betaFlags: betaFlags(),
                ...resolveRuntimeSkillOptions(scope),
            });
        },
        async listCatalogEntries(scope = {}) {
            const readScope = await resolveReadScope(scope.agentName, scope.excludeAgentResources ||
                scope.skipAgentResolution ||
                Boolean(scope.expectedAgentInstanceId));
            return registryProvider.listCatalogEntries({
                agentName: readScope.canonicalName,
                ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
                workspaceDir: scope.workspaceDir,
                betaFlags: betaFlags(),
                ...resolveRuntimeSkillOptions(scope),
            });
        },
        async readSkillByName(name, scope = {}) {
            const readScope = await resolveReadScope(scope.agentName, scope.excludeAgentResources ||
                scope.skipAgentResolution ||
                Boolean(scope.expectedAgentInstanceId));
            return registryProvider.readSkillByName(name, {
                agentName: readScope.canonicalName,
                ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
                workspaceDir: scope.workspaceDir,
                ...(deps.resourceAmbiguityTelemetry
                    ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
                    : {}),
                betaFlags: betaFlags(),
                ...resolveRuntimeSkillOptions(scope),
            });
        },
    };
}
function resolveRuntimeSkillOptions(scope) {
    return {
        ...(scope.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(scope.expectedAgentInstanceId
            ? { expectedAgentInstanceId: scope.expectedAgentInstanceId }
            : {}),
        injectableBuiltinSkillNames: scope.builtinSkillNames === undefined ? undefined : new Set(scope.builtinSkillNames),
        allowedSkillNames: toNormalizedSkillSelectorSet(scope.allowedSkillNames),
        allowedExtensionSkillNames: toNormalizedSkillSelectorSet(scope.allowedExtensionSkillNames),
    };
}
function normalizeAgentName(agentName) {
    const trimmed = agentName?.trim();
    return trimmed || 'mavis';
}
//# sourceMappingURL=reads.js.map