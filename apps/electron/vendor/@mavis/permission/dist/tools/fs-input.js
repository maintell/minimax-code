import { READ_ONLY_TOOLS } from './fs-permission.js';
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
//# sourceMappingURL=fs-input.js.map