import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
export function workspaceRootOf(scope) {
    return typeof scope === 'string' ? scope : scope.workspaceRoot;
}
/** All roots an *input* path may live under, workspace first. */
export function inputRootsOf(scope) {
    if (typeof scope === 'string')
        return [scope];
    return [scope.workspaceRoot, ...(scope.extraInputRoots ?? [])];
}
/**
 * Resolve an input path against the scope: relative paths resolve against the
 * workspace root only (never an extra root), then the absolute path must fall
 * inside the workspace root or one of the extra input roots. The realpath
 * walk in `assertWithinWorkspace` blocks symlink escapes per root.
 */
export async function resolveInputWithinScope(inputPath, scope) {
    const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRootOf(scope), inputPath);
    let firstError;
    for (const root of inputRootsOf(scope)) {
        try {
            await assertWithinWorkspace(abs, root);
            return abs;
        }
        catch (err) {
            firstError ??= err;
        }
    }
    throw firstError instanceof Error
        ? firstError
        : new Error(`Workspace path escapes Matrix tool root: ${inputPath}`);
}
export async function assertWithinWorkspace(absolutePath, workspaceRoot) {
    const rootReal = await realpath(workspaceRoot);
    let candidate = resolve(absolutePath);
    const suffixParts = [];
    while (true) {
        let ancestorReal;
        try {
            ancestorReal = await realpath(candidate);
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR')
                throw err;
            const parent = dirname(candidate);
            if (parent === candidate) {
                throw new Error(`Workspace path escapes Matrix tool root: ${absolutePath}`);
            }
            suffixParts.unshift(basename(candidate));
            candidate = parent;
            continue;
        }
        const finalPath = suffixParts.length === 0 ? ancestorReal : resolve(ancestorReal, ...suffixParts);
        const rel = relative(rootReal, finalPath);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            throw new Error(`Workspace path escapes Matrix tool root: ${absolutePath}`);
        }
        return;
    }
}
export async function resolveWithinWorkspace(inputPath, workspaceRoot) {
    const abs = isAbsolute(inputPath) ? inputPath : resolve(workspaceRoot, inputPath);
    await assertWithinWorkspace(abs, workspaceRoot);
    return abs;
}
//# sourceMappingURL=path-guard.js.map