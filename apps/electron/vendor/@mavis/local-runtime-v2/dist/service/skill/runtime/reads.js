import { toNormalizedSkillSelectorSet } from '../registry/registry-family.js';
export function createRuntimeSkillReads(deps, registryProvider) {
    const reportedCatalogOverflowSessionIds = new Set();
    const reportedCatalogDescriptionCapSessionIds = new Set();
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
    const reportCatalogOverflowOnce = (sessionId, overflowType) => {
        if (!deps.metricsClient || !sessionId || reportedCatalogOverflowSessionIds.has(sessionId))
            return;
        reportedCatalogOverflowSessionIds.add(sessionId);
        deps.metricsClient.counter('skill_catalog_overflow_observed_total', 1, { overflowType });
    };
    const reportCatalogDescriptionCapOnce = (sessionId) => {
        if (!deps.metricsClient ||
            !sessionId ||
            reportedCatalogDescriptionCapSessionIds.has(sessionId)) {
            return;
        }
        reportedCatalogDescriptionCapSessionIds.add(sessionId);
        deps.metricsClient.counter('skill_catalog_description_cap_observed_total', 1);
    };
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
        async renderCatalog(scope = {}) {
            const readScope = await resolveReadScope(scope.agentName, scope.excludeAgentResources ||
                scope.skipAgentResolution ||
                Boolean(scope.expectedAgentInstanceId));
            const result = await registryProvider.renderCatalog({
                agentName: readScope.canonicalName,
                ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
                workspaceDir: scope.workspaceDir,
                betaFlags: betaFlags(),
                contextWindowTokens: scope.contextWindowTokens,
                additionalSkills: scope.additionalSkills,
                ...resolveRuntimeSkillOptions(scope),
            });
            if (result.hardOverflow) {
                reportCatalogOverflowOnce(scope.firstTurnSessionId, 'hard');
            }
            else if (result.softOverflow) {
                reportCatalogOverflowOnce(scope.firstTurnSessionId, 'soft');
            }
            if (result.descriptionCapTruncated) {
                reportCatalogDescriptionCapOnce(scope.firstTurnSessionId);
            }
            return result.catalog;
        },
        async readSkillByName(name, scope = {}) {
            // No skillName label: user-defined names are unbounded cardinality.
            try {
                const readScope = await resolveReadScope(scope.agentName, scope.excludeAgentResources ||
                    scope.skipAgentResolution ||
                    Boolean(scope.expectedAgentInstanceId));
                const result = await registryProvider.readSkillByName(name, {
                    agentName: readScope.canonicalName,
                    ...(deps.resolveAgentReadScope
                        ? { compatibleAgentNames: readScope.compatibleNames }
                        : {}),
                    workspaceDir: scope.workspaceDir,
                    ...(deps.resourceAmbiguityTelemetry
                        ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
                        : {}),
                    betaFlags: betaFlags(),
                    ...resolveRuntimeSkillOptions(scope),
                });
                deps.metricsClient?.counter('skill_load_total', 1, {
                    status: result ? 'ok' : 'not_found',
                });
                return result;
            }
            catch (err) {
                deps.metricsClient?.counter('skill_load_total', 1, { status: 'error' });
                throw err;
            }
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