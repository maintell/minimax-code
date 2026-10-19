/**
 * Project-key helpers for the legacy Connection routes.
 *
 * The four pure helpers the connection routes need from v1
 * `project/canonical-workspace.ts` (same `workspace:<dir>` key format the
 * session system uses). Copied (MR2) because service code must not import
 * v1 values; permanent since MR3 — the legacy wire surface lives here.
 */
import path from 'node:path';
export const DEFAULT_PROJECT_KEY = 'default';
export function projectKeyForWorkspace(workspaceDir) {
    return workspaceDir ? `workspace:${workspaceDir}` : DEFAULT_PROJECT_KEY;
}
export function workspaceDirFromProjectKey(key) {
    if (!key?.startsWith('workspace:'))
        return undefined;
    return normalizeAbsolutePath(key.slice('workspace:'.length));
}
export function normalizeAbsolutePath(value) {
    const input = value?.trim();
    if (!input)
        return undefined;
    const flavor = detectPathFlavor(input);
    if (!flavor.isAbsolute(input))
        return undefined;
    const normalized = flavor.normalize(input);
    return trimTrailingSeparators(normalized, flavor.sep);
}
function detectPathFlavor(value) {
    if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
        return path.win32;
    return path.posix;
}
function trimTrailingSeparators(value, sep) {
    if (value === sep)
        return value;
    if (/^[A-Za-z]:\\$/.test(value))
        return value;
    if (value.startsWith('\\\\') && /^\\\\[^\\]+\\[^\\]+\\?$/.test(value)) {
        return value.endsWith('\\') ? value.slice(0, -1) : value;
    }
    let result = value;
    while (result.length > 1 && (result.endsWith('/') || result.endsWith('\\'))) {
        result = result.slice(0, -1);
    }
    return result;
}
//# sourceMappingURL=project-key.js.map