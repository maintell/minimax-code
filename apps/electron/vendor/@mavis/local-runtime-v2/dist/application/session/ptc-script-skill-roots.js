import { dirname } from 'node:path';
import { matchesAgentResourceInstanceSync } from '@mavis/shared/local-runtime-agent-resource-instance';
import { readConfiguredSkillRoots, withoutAgentResourceRoots, } from '../../service/skill/index.js';
/**
 * The skill roots PTC's `import()` allowlist may read.
 *
 * PTC resolves its own roots from `readConfiguredSkillRoots` instead of asking
 * the skill registry, so it has to apply the registry's Agent-resource rule
 * itself: a Turn whose profile excludes Agent resources, or whose frozen owner
 * incarnation no longer matches the marker in the Agent directory, reads no
 * agent-level root and no Agent-scoped builtin root. Without this an Agent that
 * was deleted and recreated under the same name would keep its predecessor's
 * private scripts importable by `run_code`, while the `skill` tool already
 * refuses them.
 *
 * Which roots count as Agent-private is not decided here:
 * `withoutAgentResourceRoots` is the registry's own filter, shared by both
 * readers. Only the decision to apply it is local, and it mirrors
 * `createAgentResourceScopeReader` in
 * `service/skill/registry/registry-agent-scope.ts:15-18` — no expected
 * incarnation or an explicit exclusion reads as-is, anything else verifies the
 * marker and falls back to the excluded set when it does not match.
 *
 * The marker check is the registry reader's own, in its synchronous form: the
 * roots are resolved while a Turn is assembled, with no `await` to spend, and
 * `matchesAgentResourceInstanceSync` answers exactly as the async reader does.
 */
export function ptcScriptSkillRoots(config, scope) {
    const configured = readConfiguredSkillRoots(config, scope.agentName, scope.workspaceDir);
    const roots = excludesAgentResources(config, scope)
        ? withoutAgentResourceRoots(configured)
        : configured;
    return roots.map((root) => ({
        rootPath: root.rootPath,
        // Only a root the workspace contributes may be dropped by the symlink
        // check: it comes out of the repository the user opened, which can ship
        // `.minimax` or `.agents` as a symlink. The boundary is the level holding
        // that dot directory, which is what the symlink walk starts from.
        ...(root.kind === 'workspace' ? { workspaceBoundary: dirname(dirname(root.rootPath)) } : {}),
    }));
}
/**
 * Whether this Turn reads no Agent-private resources at all.
 *
 * The synchronous twin of `createAgentResourceScopeReader`
 * (`service/skill/registry/registry-agent-scope.ts:15-18`): no expected
 * incarnation, or an explicit exclusion, settles it outright; otherwise the
 * Agent directory's `.agent-instance-id` has to still name the frozen owner.
 * That reader re-checks after the read because it caches a registry; PTC
 * resolves its roots once, while the Turn is assembled, so one check is all it
 * has — and `matchesAgentResourceInstanceSync` answers exactly as the async
 * reader does.
 */
function excludesAgentResources(config, scope) {
    if (scope.excludeAgentResources === true)
        return true;
    const { expectedAgentInstanceId } = scope;
    if (!expectedAgentInstanceId)
        return false;
    return !matchesAgentResourceInstanceSync(config.dataDir, scope.agentName, expectedAgentInstanceId);
}
//# sourceMappingURL=ptc-script-skill-roots.js.map