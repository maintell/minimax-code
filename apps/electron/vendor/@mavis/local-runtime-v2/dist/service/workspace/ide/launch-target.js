import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
export class IdeLauncherError extends Error {
    status;
    code;
    constructor(message, code, status) {
        super(message);
        this.name = 'IdeLauncherError';
        this.code = code;
        this.status = status;
    }
}
export function expandTilde(input) {
    return input.startsWith('~') ? path.join(homedir(), input.slice(1)) : input;
}
export function resolvePath(input) {
    return path.resolve(expandTilde(input));
}
function isPathInsideOrEqual(root, target) {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
export function assertWithinWorkspace(workspaceRoot, filePath) {
    const target = path.isAbsolute(filePath)
        ? path.resolve(filePath)
        : path.resolve(workspaceRoot, filePath);
    if (!isPathInsideOrEqual(workspaceRoot, target)) {
        throw new IdeLauncherError('Path traversal denied', 'PATH_TRAVERSAL', 400);
    }
}
export async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    }
    catch {
        return false;
    }
}
export async function assertRegularFileExists(absolutePath) {
    try {
        const info = await fs.stat(absolutePath);
        if (!info.isFile()) {
            throw new IdeLauncherError('File not found', 'NOT_FOUND', 404);
        }
    }
    catch (error) {
        if (error instanceof IdeLauncherError)
            throw error;
        throw new IdeLauncherError('File not found', 'NOT_FOUND', 404);
    }
}
//# sourceMappingURL=launch-target.js.map