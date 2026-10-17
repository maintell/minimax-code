import { configReviewBlocks, } from '../../content-safety/index.js';
import { createLocalSkill } from './api.js';
import { LocalSkillHubInstallError, } from './hub-api.js';
export function createLocalSkillService(deps) {
    const runtime = deps.runtime;
    const notifyRuntimeSkillsChanged = () => runtime.notifyRuntimeSkillsChanged();
    const resolveReadScope = (name, skip = false) => resolveManagementReadScope(deps, name, skip);
    const resolveWriteTarget = async (requestedName) => {
        if (!requestedName)
            return undefined;
        const requested = normalizeAgentName(requestedName);
        return (await deps.resolveAgentWriteTarget?.(requested))?.trim() || requested;
    };
    const resolveRequestScope = async (input) => {
        // A physical location is already an exact identity. Do not infer an agent
        // from it (or reassign it to the default agent) when the caller omitted one.
        if (input.locationUri && !input.agentName) {
            return {
                ...input,
                ...(deps.resourceAmbiguityTelemetry
                    ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
                    : {}),
            };
        }
        const readScope = await resolveReadScope(input.agentName, input.excludeAgentResources || Boolean(input.expectedAgentInstanceId));
        return {
            ...input,
            agentName: readScope.canonicalName,
            ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
            ...(deps.resourceAmbiguityTelemetry
                ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
                : {}),
        };
    };
    const betaFlags = () => ({
        ...(deps.configGetter().beta ?? {}),
    });
    const requireHub = () => {
        if (!deps.skillHubStore) {
            throw new LocalSkillHubInstallError('Desktop skill hub store is not configured', 'SKILL_HUB_UNAVAILABLE', 503);
        }
        return deps.skillHubStore;
    };
    return {
        runtime,
        async listSkills(input) {
            return runtime.withRegistry(async (lease) => {
                const scope = await resolveReadScope(input.agentName, input.excludeAgentResources || Boolean(input.expectedAgentInstanceId));
                const installedHubMetadataByLocationUri = await deps.skillHubStore?.getInstalledGlobalMetadataByLocation();
                return lease.registry.listSkills({
                    ...input,
                    agentName: scope.canonicalName,
                    ...(deps.resolveAgentReadScope ? { compatibleAgentNames: scope.compatibleNames } : {}),
                    betaFlags: betaFlags(),
                }, installedHubMetadataByLocationUri);
            });
        },
        listRuntimeSkills: (scope) => runtime.listRuntimeSkills(scope),
        renderCatalog: (scope) => runtime.renderCatalog(scope),
        readSkillByName: (name, scope) => runtime.readSkillByName(name, scope),
        async getSkill(input, options = {}) {
            return runtime.withRegistry(async (lease) => {
                const resolved = await resolveRequestScope(input);
                return lease.registry.getSkillDetail(resolved, options);
            });
        },
        async listSkillFiles(input) {
            return runtime.withRegistry(async (lease) => {
                return lease.registry.listSkillFiles(await resolveRequestScope(input));
            });
        },
        async readSkillFile(input) {
            return runtime.withRegistry(async (lease) => {
                return lease.registry.readSkillFile(await resolveRequestScope(input));
            });
        },
        async createSkill(input) {
            return runtime.withRegistry(async (lease) => {
                const dataDir = deps.configGetter().dataDir;
                if (!dataDir) {
                    return {
                        ok: false,
                        status: 503,
                        code: 'SKILL_UNAVAILABLE',
                        message: 'Desktop skill dataDir is not configured',
                    };
                }
                // Gate user-authored skill text before persisting. Same fail policy as the
                // agent config gate (configReviewBlocks): rejected / local_error block,
                // api_error degrade-passes. The 422 stays generic so no review detail leaks.
                if (await configReviewBlocks(deps.reviewContent, [
                    input.name,
                    input.description,
                    input.content,
                ])) {
                    return {
                        ok: false,
                        status: 422,
                        code: 'CONTENT_POLICY_VIOLATION',
                        message: 'Content validation failed',
                    };
                }
                const agentName = await resolveWriteTarget(input.agentName);
                const result = await createLocalSkill({
                    dataDir,
                    ...input,
                    hasBuiltinSkill: lease.hasBuiltinSkill,
                    ...(agentName ? { agentName } : {}),
                });
                if (result.ok) {
                    await lease.registry.refresh({ agentName });
                    notifyRuntimeSkillsChanged();
                }
                return result;
            });
        },
        async deleteSkill(input) {
            return runtime.withRegistry(async (lease) => {
                // The Desktop adapter always includes the optional `agentName` field,
                // even when the request is a global name-only delete. Preserve that
                // ingress shape so the registry can address global skills directly;
                // direct domain callers without the field still resolve through the
                // default agent scope and retain the exact-delete contract.
                const transportGlobalDelete = Object.hasOwn(input, 'agentName') && !input.agentName && !input.locationUri;
                const deleted = await lease.registry.deleteSkill(transportGlobalDelete ? input : await resolveRequestScope(input));
                if (deleted === 'protected')
                    return 'protected';
                if (!deleted) {
                    const uninstalled = transportGlobalDelete
                        ? await deps.skillHubStore?.uninstall(input.skillName)
                        : false;
                    if (uninstalled) {
                        notifyRuntimeSkillsChanged();
                        return { ok: true, name: input.skillName };
                    }
                    return undefined;
                }
                // Clear the hub `installed` record for any global (non-agent) skill delete
                // so the market "added" badge resets — even when the caller passed a
                // locationUri. Key by the actually-deleted entry's name, which matches the
                // identity install stores under.
                if (!input.agentName)
                    await deps.skillHubStore?.uninstall(deleted.name);
                notifyRuntimeSkillsChanged();
                return deleted;
            });
        },
        setSkillEnabled: (input, enabled) => runtime.setSkillEnabled(input, enabled),
        async listSkillHub(input) {
            return runtime.withRegistry(async () => {
                const resp = await requireHub().list({
                    keyword: input.keyword,
                    limit: input.limit,
                    nextToken: input.cursor,
                    sourceType: input.sourceType,
                    sortType: input.sortType,
                });
                return {
                    skills: resp.skill_list,
                    hasMore: resp.has_more,
                    nextCursor: resp.next_token,
                };
            });
        },
        async installSkill(input) {
            return runtime.withRegistry(async (lease) => {
                const agentName = await resolveWriteTarget(input.agentName);
                const resp = await requireHub().install({
                    url: input.url,
                    agent_name: agentName,
                    is_from_git: input.isFromGit,
                    display_name: input.displayName,
                    creator_info: input.creatorInfo,
                    publisher_source_type: input.publisherSourceType,
                });
                await lease.registry.refresh({ agentName });
                notifyRuntimeSkillsChanged();
                return { ok: resp.ok, skill: resp.skill };
            });
        },
        previewSkill(input) {
            return runtime.withRegistry(() => requireHub().preview(input));
        },
        onDidChangeRuntimeSkills: (listener) => runtime.onDidChangeRuntimeSkills(listener),
    };
}
function normalizeAgentName(agentName) {
    const trimmed = agentName?.trim();
    return trimmed || 'mavis';
}
async function resolveManagementReadScope(deps, requestedName, skipAgentResolution = false) {
    const requested = normalizeAgentName(requestedName);
    if (skipAgentResolution || !deps.resolveAgentReadScope) {
        return { canonicalName: requested, compatibleNames: [requested] };
    }
    const resolved = await deps.resolveAgentReadScope(requested);
    const canonicalName = resolved.canonicalName.trim() || requested;
    const compatibleNames = [canonicalName, ...(resolved.compatibleNames ?? [])].filter((name, index, names) => name.trim().length > 0 &&
        names.findIndex((candidate) => candidate.trim() === name.trim()) === index);
    return { canonicalName, compatibleNames };
}
//# sourceMappingURL=skill-service.js.map