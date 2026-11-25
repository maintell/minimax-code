import { resolveFeatureAwareBuiltinSkillNames } from './feature-owned-skills.js';
/** Keep list and catalog on one turn snapshot, independently for each hosted consumer. */
export function createHostedSkillReads(reads) {
    const consumers = new WeakMap();
    const resolveScope = (scope, context) => {
        let snapshots = consumers.get(context);
        if (!snapshots) {
            snapshots = new WeakMap();
            consumers.set(context, snapshots);
        }
        const existing = snapshots.get(scope);
        if (existing)
            return existing;
        const resolved = resolveHostedCatalogScope(scope, context);
        snapshots.set(scope, resolved);
        return resolved;
    };
    return {
        listHostedRuntimeSkills: (scope, context) => reads.listRuntimeSkills(resolveScope(scope, context)),
        listHostedCatalogEntries: (scope, context) => reads.listCatalogEntries(resolveScope(scope, context)),
    };
}
function resolveHostedCatalogScope(scope, context) {
    const base = {
        agentName: scope.agentName,
        workspaceDir: scope.workspaceDir,
        ...(scope.computerUseActive === undefined
            ? {}
            : { computerUseActive: scope.computerUseActive }),
        ...(scope.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(scope.expectedAgentInstanceId
            ? { expectedAgentInstanceId: scope.expectedAgentInstanceId }
            : {}),
        ...(scope.skipAgentResolution ? { skipAgentResolution: true } : {}),
        ...(scope.allowedSkillNames === undefined
            ? {}
            : { allowedSkillNames: scope.allowedSkillNames }),
        ...(scope.allowedExtensionSkillNames === undefined
            ? {}
            : { allowedExtensionSkillNames: scope.allowedExtensionSkillNames }),
    };
    const selection = scope.agentPolicy ? resolveHostedSelection(scope, context) : {};
    return {
        ...base,
        ...selection,
    };
}
function resolveHostedSelection(scope, context) {
    const policy = scope.agentPolicy;
    if (!policy)
        return {};
    const restrictions = context.restrictions;
    const capabilities = restrictions.disableMavis
        ? { ...policy.capabilities, features: { ...policy.capabilities.features, mavis: false } }
        : policy.capabilities;
    return {
        builtinSkillNames: resolveFeatureAwareBuiltinSkillNames(capabilities, {
            computerUseActive: scope.computerUseActive === true,
            ...(scope.miniappAvailable === true ? { miniappAvailable: true } : {}),
            ...(scope.pluginRecommendationAvailable === true
                ? { pluginRecommendationAvailable: true }
                : {}),
            ...(scope.desktopManageAvailable === true ? { desktopManageAvailable: true } : {}),
            ...(scope.cronToolsAvailable === true ? { cronToolsAvailable: true } : {}),
            ...(scope.memoryToolsAvailable === true ? { memoryToolsAvailable: true } : {}),
            canonicalRole: policy.canonicalRole,
            builtinAgent: policy.builtinAgent,
            ...(policy.coordinator === true ? { coordinator: true } : {}),
            disabledSkillNames: restrictions.disabledBuiltinSkillNames,
            resumeCodexAvailable: restrictions.resumeCodexAvailable === true,
        }),
    };
}
//# sourceMappingURL=hosted-reader.js.map