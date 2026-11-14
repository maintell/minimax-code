import { dirname } from 'node:path';
import { filterCanonicalNativeToolCeiling, } from '@mavis/agent-tools';
/**
 * The script directories and the save tool's boundaries for this Turn, or
 * undefined when the host wired no script support (every current caller except
 * the Desktop production composition, and every non-PTC Turn).
 */
export function ptcScriptSupport(input) {
    if (!input.ptcScripts)
        return undefined;
    const directories = {
        workspaceDir: input.workspaceDir ?? '',
        agentName: input.agentName ?? '',
        ...(input.isDefaultWorkspace ? { isDefaultWorkspace: true } : {}),
        ...(input.agentProfile?.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.agentProfile.expectedAgentInstanceId }
            : {}),
        ...(input.agentProfile?.excludeAgentResources ? { excludeAgentResources: true } : {}),
    };
    // The loader and the catalog get the roots that survived the symlink check,
    // so a project directory reached through a link is not importable and not
    // listed. The save tool gets the directory as it really is, so such a link
    // is refused by its own check, with its own message.
    const roots = input.ptcScripts.importable(directories);
    const saveRoots = input.ptcScripts.resolve(directories);
    return {
        roots,
        save: {
            ...(saveRoots.project
                ? { project: { directory: saveRoots.project, boundary: saveRoots.workspaceDir } }
                : {}),
            // The boundary is the data directory, not the `ptc` directory itself:
            // the check walks the segments below the boundary, so this is what makes
            // it look at `ptc` at all, while a data directory that is itself a
            // symlink (a legitimate profile alias) is never inspected.
            user: { directory: saveRoots.user, boundary: dirname(saveRoots.user) },
            assertNoSymlink: input.ptcScripts.assertNoSymlink,
            refusedImport: input.ptcScripts.refusedImport,
        },
    };
}
/**
 * Whether this Turn may offer `save_run_code_script`. It is a builtin native tool
 * that PTC creates after `filterLocalTurnCapabilityInventory` ran, so the two
 * gates that inventory applies to a native tool are repeated here: the Agent
 * and model gates, then the canonical role ceiling. Without this the `tools`
 * allowlist, `disallowedTools` and the explore / verifier / worker ceilings
 * could not reach it.
 *
 * The first gate is `isReadyTurnToolAllowed`, which stays private to
 * local-turn-tool-catalog.ts and reads that Turn's own gates, so the caller passes
 * it in as `isToolAllowed` rather than this module importing the catalog:
 * the catalog already imports this module for the script roots, and the reverse
 * import would make the two depend on each other.
 */
export function isPtcSaveScriptAllowed(tool, profile, isToolAllowed) {
    if (!isToolAllowed(tool))
        return false;
    return (filterCanonicalNativeToolCeiling([tool], profile?.canonicalRole, profile?.trustedBuiltin === true).length > 0);
}
//# sourceMappingURL=local-turn-tool-ptc-scripts.js.map