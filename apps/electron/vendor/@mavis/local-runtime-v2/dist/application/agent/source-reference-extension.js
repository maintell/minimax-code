import { sourceReferenceExtension } from '@mavis/agent-extension';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
export function createRuntimeSourceReferenceExtension(attachmentRegistration) {
    return sourceReferenceExtension({
        resolveFileSourcePath: ({ path, turn, origin }) => {
            const source = attachmentRegistration.resolveSource({
                sessionId: turn.sessionId,
                filePath: path,
            });
            if (source)
                return { path: source.filePath, name: source.fileName };
            return resolveWorkspaceFileSource(path, turn.workspaceDir, origin === 'diff-result');
        },
    });
}
function resolveWorkspaceFileSource(candidatePath, workspaceDir, requireExistingFile = false) {
    const pathApi = isWindowsPath(candidatePath) || isWindowsPath(workspaceDir) ? win32 : posix;
    if (!pathApi.isAbsolute(candidatePath) || !pathApi.isAbsolute(workspaceDir))
        return undefined;
    const workspacePath = pathApi.resolve(workspaceDir);
    const resolvedPath = pathApi.resolve(candidatePath);
    const relativePath = pathApi.relative(workspacePath, resolvedPath);
    if (!relativePath ||
        pathApi.isAbsolute(relativePath) ||
        relativePath === '..' ||
        relativePath.startsWith(`..${pathApi.sep}`)) {
        return undefined;
    }
    return existingWorkspaceFileSource({ path: resolvedPath, name: pathApi.basename(resolvedPath) }, requireExistingFile);
}
function existingWorkspaceFileSource(source, required) {
    return required && !existsSync(source.path) ? undefined : source;
}
function isWindowsPath(value) {
    return /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(value);
}
//# sourceMappingURL=source-reference-extension.js.map