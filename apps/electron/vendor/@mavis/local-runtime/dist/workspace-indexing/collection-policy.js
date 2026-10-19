import path from 'node:path';
import { DEFAULT_COLLECTION_POLICY } from '@mavis/shared/collection-policy';
import { createCollectionPolicyMatcher } from '@mavis/shared/collection-policy/matcher';
const bindings = new WeakMap();
/**
 * Resolves the policy binding for one operation. A configuration getter is a
 * weak dependency: a throwing or empty getter falls back to the built-in
 * policy rather than failing the capture, because the scanner's own security
 * baseline — not this policy — is what keeps sensitive paths out.
 */
export function resolveWorkspaceCollectionPolicy(getCollectionPolicy) {
    const policy = readCollectionPolicy(getCollectionPolicy);
    const cached = bindings.get(policy);
    if (cached)
        return cached;
    const binding = createBinding(policy);
    bindings.set(policy, binding);
    return binding;
}
function readCollectionPolicy(getCollectionPolicy) {
    if (!getCollectionPolicy)
        return DEFAULT_COLLECTION_POLICY;
    try {
        return getCollectionPolicy() ?? DEFAULT_COLLECTION_POLICY;
    }
    catch {
        return DEFAULT_COLLECTION_POLICY;
    }
}
function createBinding(policy) {
    const matcher = createCollectionPolicyMatcher(policy);
    return {
        policy,
        workspaceVersion: matcher.workspaceVersion,
        // Negative-only globs: a policy can tighten the scan but can never
        // re-include a path the scan baseline or the security deny-list dropped.
        excludeArgs: policy.workspace.exclude_globs.map((glob) => `--iglob=!${glob}`),
        excludesWorkspacePath: (relativePath) => matcher.excludesWorkspacePath(normalizeWorkspaceRelativePath(relativePath)),
    };
}
export function normalizeWorkspaceRelativePath(value) {
    return value.replaceAll('\\', '/');
}
/**
 * Maps an absolute path back onto the Workspace-relative form the policy
 * matches against. Returns `undefined` when the path escapes the Workspace,
 * which callers already treat as non-capturable.
 */
export function toWorkspaceRelativePath(workspaceRealPath, absolutePath) {
    const relative = path.relative(workspaceRealPath, absolutePath);
    if (!relative || path.isAbsolute(relative))
        return undefined;
    const normalized = normalizeWorkspaceRelativePath(relative);
    return normalized === '..' || normalized.startsWith('../') ? undefined : normalized;
}
/**
 * Resolves a symlink's stored target lexically, the way a restore would, so a
 * link pointing into an excluded directory is rejected even when the link's
 * own path is allowed.
 */
export function resolveSymlinkTargetPath(entryPath, linkTarget) {
    if (path.posix.isAbsolute(linkTarget) || path.isAbsolute(linkTarget))
        return undefined;
    const directory = path.posix.dirname(normalizeWorkspaceRelativePath(entryPath));
    const resolved = path.posix.normalize(path.posix.join(directory === '.' ? '' : directory, normalizeWorkspaceRelativePath(linkTarget)));
    return resolved === '..' || resolved.startsWith('../') ? undefined : resolved;
}
/**
 * Whether every path a manifest would publish still satisfies the policy.
 * Used before any remote transfer so a capture taken under a looser policy is
 * held back instead of shipping now-prohibited paths.
 *
 * A manifest whose entries are missing or malformed cannot be proven
 * compliant, so it reports non-compliant rather than throwing — callers that
 * need to distinguish "violates the policy" from "unreadable artifact"
 * validate the shape before asking.
 */
export function isManifestPolicyCompliant(manifest, binding) {
    if (!Array.isArray(manifest?.entries))
        return false;
    return !manifest.entries.some((entry) => isManifestEntryExcluded(entry, binding));
}
function isManifestEntryExcluded(entry, binding) {
    if (binding.excludesWorkspacePath(entry.path))
        return true;
    if (entry.kind !== 'symlink')
        return false;
    const target = resolveSymlinkTargetPath(entry.path, entry.linkTarget);
    // An unresolvable (escaping or absolute) target is never restorable inside
    // the Workspace, so it is not a policy decision to make here.
    return target !== undefined && binding.excludesWorkspacePath(target);
}
//# sourceMappingURL=collection-policy.js.map