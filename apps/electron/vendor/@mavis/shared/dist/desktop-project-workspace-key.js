/**
 * The one rule for turning a workspace directory into a desktop Project key.
 *
 * The sidebar UI groups projects by this key, and the Runtime's sidebar section
 * rows are keyed by it too, so the two must agree exactly: a project whose key
 * differs between the two sides simply does not match the section it lives in.
 * Both sides therefore call this module instead of keeping a copy.
 *
 * The rule mirrors Local Runtime's lexical path normalization without Node's
 * `path` module, so the renderer can run it.
 */
const NESTED_AGENT_WORKTREE_PARENT = '.\x63\x6c\x61\x75\x64\x65';
/**
 * Normalize a workspace path into the path representation used by desktop
 * project grouping: backslashes become slashes, repeated slashes collapse
 * (a leading `//` is kept for UNC), `/./` segments drop, and a trailing slash
 * goes away except on a Windows drive root.
 */
export function normalizeWorkspaceGroupPath(workspacePath) {
    let result = workspacePath.replace(/\\/gu, '/');
    const leadingSlashes = /^\/\//.test(result) ? '//' : '';
    if (leadingSlashes)
        result = leadingSlashes + result.slice(2).replace(/\/\/+/gu, '/');
    else
        result = result.replace(/\/\/+/gu, '/');
    result = result.replace(/\/\.\//gu, '/').replace(/\/\.$/u, '/');
    const isWindowsDriveRoot = /^[A-Za-z]:\/$/u.test(result);
    if (!isWindowsDriveRoot && result.length > 1 && result.endsWith('/')) {
        result = result.replace(/\/+$/u, '');
    }
    return result;
}
function isHomeExternalWorktreePool(prefixParts) {
    const parts = prefixParts.filter(Boolean);
    if (parts.length === 2 && ['Users', 'home'].includes(parts[0] ?? ''))
        return true;
    return (parts.length === 3 && /^[A-Za-z]:$/u.test(parts[0] ?? '') && parts[1]?.toLowerCase() === 'users');
}
function findWorktreeMarkerIndex(parts) {
    const simpleIndex = parts.findIndex((part) => part === '.worktrees' || part === '.worktree');
    if (simpleIndex >= 0 && simpleIndex < parts.length - 1)
        return simpleIndex;
    const nestedIndex = parts.findIndex((part, index) => part === NESTED_AGENT_WORKTREE_PARENT && parts[index + 1] === 'worktrees');
    return nestedIndex >= 0 && nestedIndex < parts.length - 2 ? nestedIndex : undefined;
}
/**
 * Resolve a workspace path to the project group it belongs to. A repo-local
 * `<repo>/.worktrees/<name>` path shares the parent repository's project, while
 * an external worktree pool under a home directory stays its own project unless
 * the caller supplied the persisted parent repository.
 */
function resolveDesktopGroupDir(workspacePath, preserveExternalPool) {
    const normalizedPath = normalizeWorkspaceGroupPath(workspacePath);
    if (!normalizedPath)
        return workspacePath;
    const parts = normalizedPath.split('/');
    const markerIndex = findWorktreeMarkerIndex(parts);
    if (markerIndex === undefined || markerIndex <= 0)
        return normalizedPath;
    const beforeMarker = parts.slice(0, markerIndex).filter(Boolean);
    if (preserveExternalPool && isHomeExternalWorktreePool(beforeMarker))
        return normalizedPath;
    const root = parts.slice(0, markerIndex).join('/');
    if (/^[A-Za-z]:$/u.test(root))
        return `${root}/`;
    if (normalizedPath.startsWith('/') && !root.startsWith('/'))
        return `/${root}`;
    return root || normalizedPath;
}
/**
 * Canonical desktop Project directory: the group directory, or the group of the
 * caller's persisted parent repository when it has one.
 */
export function desktopProjectWorkspaceGroupDir(workspacePath, parentRepoDir) {
    return resolveDesktopGroupDir(parentRepoDir || workspacePath, !parentRepoDir);
}
/**
 * Stable comparison key for desktop Runtime Project identities. Windows paths
 * compare case-insensitively; every other path keeps its case.
 */
export function desktopProjectWorkspaceGroupKey(workspacePath, parentRepoDir) {
    const groupDir = desktopProjectWorkspaceGroupDir(workspacePath, parentRepoDir);
    const isWindowsPath = /^[A-Za-z]:(?:\/|$)/u.test(groupDir) || groupDir.startsWith('//');
    return isWindowsPath ? groupDir.toLowerCase() : groupDir;
}
//# sourceMappingURL=desktop-project-workspace-key.js.map