import os from 'node:os';
import { READ_ONLY_TOOLS, validatePath } from './fs-permission.js';
import { resolveCanonicalPath } from './path-identity.js';
export const WRITE_TOOLS = new Set(['edit', 'write', 'append']);
export function isFsTool(toolName) {
    return READ_ONLY_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName);
}
export function toolActionForFsTool(toolName) {
    return WRITE_TOOLS.has(toolName) ? 'write' : 'read';
}
/** Canonical execution fields win; compatibility aliases must not redirect permission checks. */
export function extractFilePath(toolName, input) {
    if (toolName === 'edit' && typeof input.file_path === 'string')
        return input.file_path;
    if (typeof input.path === 'string')
        return input.path;
    if (typeof input.file_path === 'string')
        return input.file_path;
    if (typeof input.filePath === 'string')
        return input.filePath;
    // Search patterns describe matching content or names, never an execution path.
    return undefined;
}
/** Where a write or edit lands, resolved the way its permission check resolves it. */
export function resolveWriteTargetLocation(toolName, input, workingDirectory) {
    if (!WRITE_TOOLS.has(toolName))
        return undefined;
    const filePath = extractFilePath(toolName, input);
    if (filePath === undefined)
        return undefined;
    const validated = validatePath(filePath, workingDirectory, os.homedir());
    if (!validated.valid || !validated.resolved)
        return undefined;
    const canonicalPath = resolveCanonicalPath(validated.resolved);
    return canonicalPath === undefined
        ? undefined
        : { resolvedPath: validated.resolved, canonicalPath };
}
//# sourceMappingURL=fs-input.js.map