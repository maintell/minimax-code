import path from 'node:path';
import { LEGACY_DATA_DIR_BASENAME, NEW_DATA_DIR_BASENAME } from '@mavis/config/data-dir';
import { normalizeAbsolutePath, pathFlavor } from './path-normalization.js';
import { collapseWorktreePath } from './worktree-path.js';
export function canonicalProjectWorkspaceDir(workspaceDir, runLocation) {
    const parentRepoDir = normalizeAbsolutePath(runLocation?.parentRepoDir);
    if (parentRepoDir)
        return collapseWorktreePath(parentRepoDir);
    const normalizedWorkspaceDir = normalizeAbsolutePath(workspaceDir);
    return normalizedWorkspaceDir ? collapseWorktreePath(normalizedWorkspaceDir) : undefined;
}
/**
 * Recognize the historical runtime-owned `<dataDir>/sessions/<sessionId>/workspace`
 * execution directory without depending on the dataDir's symlink or profile name.
 */
export function isSessionDefaultWorkspaceDir(workspaceDir, sessionId) {
    if (!sessionId || /[\\/]/u.test(sessionId))
        return false;
    const normalized = normalizeAbsolutePath(workspaceDir ?? undefined);
    if (!normalized)
        return false;
    const windows = /^[A-Za-z]:[\\/]/u.test(normalized) || normalized.startsWith('\\\\');
    const parts = normalized.split(windows ? /[\\/]+/u : /\/+/u).filter(Boolean);
    const samePart = (value, expected) => value !== undefined &&
        (windows ? value.toLowerCase() === expected.toLowerCase() : value === expected);
    return (samePart(parts.at(-1), 'workspace') &&
        samePart(parts.at(-2), sessionId) &&
        samePart(parts.at(-3), 'sessions'));
}
/** Match current and historical internal Agent fallback workspaces without filesystem access. */
export function isAgentInternalDefaultWorkspaceDir(workspaceDir, currentAgentInternalWorkspaceDir, agentName) {
    if (!isValidAgentWorkspaceName(agentName))
        return false;
    const paths = normalizeAgentWorkspacePaths(workspaceDir, currentAgentInternalWorkspaceDir);
    if (!paths)
        return false;
    const currentFlavor = pathFlavor(paths.current);
    if (pathFlavor(paths.workspace) !== currentFlavor)
        return false;
    const windows = currentFlavor === path.win32;
    return (pathsEqual(paths.workspace, paths.current, windows) ||
        isLegacyAgentInternalWorkspaceAlias(paths.workspace, paths.current, agentName));
}
function isValidAgentWorkspaceName(agentName) {
    return agentName.trim().length > 0 && !/[\\/]/u.test(agentName);
}
function normalizeAgentWorkspacePaths(workspaceDir, currentAgentInternalWorkspaceDir) {
    const workspace = normalizeAbsolutePath(workspaceDir);
    const current = normalizeAbsolutePath(currentAgentInternalWorkspaceDir);
    return workspace && current ? { workspace, current } : undefined;
}
function isLegacyAgentInternalWorkspaceAlias(workspace, current, agentName) {
    const legacy = parseAgentWorkspacePath(workspace, agentName);
    const active = parseAgentWorkspacePath(current, agentName);
    if (!legacy || !active || legacy.windows !== active.windows)
        return false;
    return (hasLegacyAgentDataDirectoryAlias(active, legacy) &&
        pathsEqual(active.parentDir, legacy.parentDir, active.windows) &&
        pathsEqual(active.profileSuffix, legacy.profileSuffix, active.windows));
}
function hasLegacyAgentDataDirectoryAlias(active, legacy) {
    if (active.windows) {
        return (active.dataDirBase.toLowerCase() === NEW_DATA_DIR_BASENAME &&
            legacy.dataDirBase.toLowerCase() === LEGACY_DATA_DIR_BASENAME);
    }
    return (active.dataDirBase === NEW_DATA_DIR_BASENAME &&
        legacy.dataDirBase === LEGACY_DATA_DIR_BASENAME);
}
function parseAgentWorkspacePath(value, agentName) {
    const flavor = pathFlavor(value);
    const windows = flavor === path.win32;
    const root = flavor.parse(value).root;
    const parts = value
        .slice(root.length)
        .split(windows ? /[\\/]+/u : /\/+/u)
        .filter(Boolean);
    if (parts.length < 4)
        return undefined;
    if (!samePathPart(parts.at(-1), 'workspace', windows) ||
        !samePathPart(parts.at(-2), agentName, windows) ||
        !samePathPart(parts.at(-3), 'agents', windows)) {
        return undefined;
    }
    const dataDirPart = parts.at(-4);
    const match = dataDirPart?.match(/^\.(minimax|mavis)(?:-(.+))?$/i);
    if (!match?.[1])
        return undefined;
    return {
        windows,
        parentDir: `${root}${parts.slice(0, -4).join(flavor.sep)}`,
        dataDirBase: `.${match[1]}`,
        profileSuffix: match[2] ?? '',
    };
}
function samePathPart(value, expected, windows) {
    return (value !== undefined &&
        (windows ? value.toLowerCase() === expected.toLowerCase() : value === expected));
}
function pathsEqual(left, right, windows) {
    return windows ? left.toLowerCase() === right.toLowerCase() : left === right;
}
//# sourceMappingURL=workspace.js.map