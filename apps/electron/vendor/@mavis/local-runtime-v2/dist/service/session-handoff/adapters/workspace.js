import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compareHandoffPaths, isSensitiveHandoffPath, } from '../admission/recommendation.js';
import { SessionHandoffError } from '../errors.js';
const MAX_EXPLICIT_SENSITIVE_FILES = 200;
const MAX_APPROVED_FILES = 10_000;
export function createHandoffWorkspacePort(options) {
    const stagingRoot = join(options.dataDir, 'v2', 'session-handoff', 'staging');
    const activeStaging = new Set();
    const cleanupOrphans = (retainedStagingDirs = []) => cleanupOrphanStaging(stagingRoot, activeStaging, retainedStagingDirs);
    return {
        scan: options.scan,
        inspectSensitive: (workspaceDir, relativePaths) => inspectSensitiveFiles(workspaceDir, relativePaths),
        resolveApprovedPaths: (workspaceDir, absolutePaths) => resolveApprovedWorkspacePaths(workspaceDir, absolutePaths),
        inspectExplicit: (workspaceDir, relativePaths) => inspectExplicitFiles(workspaceDir, relativePaths),
        cleanupOrphans,
        stage: async (input) => {
            const workspaceRoot = await realpath(input.workspaceDir);
            const operation = createHash('sha256').update(input.operationId).digest('hex');
            const stagingDir = join(stagingRoot, operation);
            activeStaging.add(stagingDir);
            try {
                await rm(stagingDir, { recursive: true, force: true });
                await mkdir(stagingDir, { recursive: true, mode: 0o700 });
                const selected = new Set(input.selectedPaths);
                const files = input.files.filter((file) => selected.has(file.relativePath));
                if (files.length !== selected.size) {
                    throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Selected Workspace files changed before staging');
                }
                for (const file of files) {
                    await stageFile(workspaceRoot, stagingDir, file);
                }
                return { stagingDir, files };
            }
            catch (error) {
                await removeStagingBestEffort(stagingDir);
                activeStaging.delete(stagingDir);
                throw error;
            }
        },
        cleanupStaging: async (stagingDir) => {
            if (!pathWithin(stagingRoot, stagingDir)) {
                throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Refusing to clean a staging path outside the runtime data directory');
            }
            try {
                await rm(stagingDir, { recursive: true, force: true });
            }
            finally {
                activeStaging.delete(stagingDir);
            }
        },
    };
}
async function removeStagingBestEffort(stagingDir) {
    try {
        await rm(stagingDir, { recursive: true, force: true });
    }
    catch {
        // Preserve the source staging error; orphan recovery retries this removal.
    }
}
async function cleanupOrphanStaging(stagingRoot, activeStaging, retainedStagingDirs) {
    const retained = new Set(retainedStagingDirs
        .map((path) => resolve(path))
        .filter((path) => pathWithin(stagingRoot, path)));
    let entries;
    try {
        entries = await readdir(stagingRoot, { withFileTypes: true });
    }
    catch (error) {
        if (isErrorCode(error, 'ENOENT'))
            return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const candidate = join(stagingRoot, entry.name);
        if (activeStaging.has(candidate) || retained.has(resolve(candidate)))
            continue;
        await rm(candidate, { recursive: true, force: true });
    }
}
async function stageFile(workspaceRoot, stagingDir, file) {
    if (!safeRelativePath(file.relativePath)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Workspace file path is unsafe');
    }
    const source = resolve(workspaceRoot, file.relativePath);
    if (!pathWithin(workspaceRoot, source)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Workspace file escaped its root');
    }
    const linkMetadata = await lstat(source);
    if (!linkMetadata.isFile() || linkMetadata.isSymbolicLink()) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Only regular Workspace files can be handed off');
    }
    const sourceRealPath = await realpath(source);
    if (!pathWithin(workspaceRoot, sourceRealPath)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Workspace file escaped its root');
    }
    const target = resolve(stagingDir, file.relativePath);
    if (!pathWithin(stagingDir, target)) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Staging file escaped its root');
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(sourceRealPath, target);
    const copied = await hashFile(target);
    if (copied.sizeBytes !== file.sizeBytes || copied.sha256 !== file.sha256) {
        throw new SessionHandoffError('WORKSPACE_REVISION_STALE', 'Workspace file changed while staging the handoff');
    }
}
async function resolveApprovedWorkspacePaths(workspaceDir, absolutePaths) {
    if (absolutePaths.length > MAX_APPROVED_FILES) {
        throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Handoff selection is invalid');
    }
    const workspaceRoot = await realpath(workspaceDir);
    const selected = new Set();
    for (const rawPath of absolutePaths) {
        const absolutePath = rawPath.trim();
        if (!isAbsolute(absolutePath)) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Handoff selection must use absolute local paths');
        }
        const metadata = await requireSelectedFile(lstat(absolutePath));
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Only regular Workspace files can be handed off');
        }
        const physicalPath = await requireSelectedFile(realpath(absolutePath));
        if (!pathWithin(workspaceRoot, physicalPath)) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Selected file is outside the Session Workspace');
        }
        const relativePath = relative(workspaceRoot, physicalPath).split(sep).join('/');
        if (!safeRelativePath(relativePath)) {
            throw new SessionHandoffError('HANDOFF_SELECTION_INVALID', 'Workspace file path is unsafe');
        }
        selected.add(relativePath);
    }
    return [...selected].sort(compareHandoffPaths);
}
/**
 * 批准之后、上传之前被删掉的选中文件是最常见的一种"选择需要修正":裸 ENOENT 会
 * 变成不可解释的 500,还会把完整本地路径写进持久化的 failureMessage。这里只翻译
 * 已确认不存在的两种 errno,权限等其他失败保持原样,免得把它们伪装成可重试。
 */
async function requireSelectedFile(work) {
    try {
        return await work;
    }
    catch (error) {
        if (!isErrorCode(error, 'ENOENT') && !isErrorCode(error, 'ENOTDIR'))
            throw error;
        throw new SessionHandoffError('HANDOFF_FILE_NOT_FOUND', 'A selected Workspace file no longer exists');
    }
}
async function inspectExplicitFiles(workspaceDir, relativePaths) {
    const workspaceRoot = await realpath(workspaceDir);
    const candidates = [...new Set(relativePaths.map((path) => path.replaceAll('\\', '/')))]
        .filter(safeRelativePath)
        .sort(compareHandoffPaths)
        .slice(0, MAX_APPROVED_FILES);
    const files = [];
    for (const relativePath of candidates) {
        const file = await inspectWorkspaceFile(workspaceRoot, relativePath);
        if (file)
            files.push(file);
    }
    return files;
}
async function inspectSensitiveFiles(workspaceDir, relativePaths) {
    const workspaceRoot = await realpath(workspaceDir);
    const candidates = [...new Set(relativePaths.map((path) => path.replaceAll('\\', '/')))]
        .filter((path) => safeRelativePath(path) && isSensitiveHandoffPath(path))
        .sort(compareHandoffPaths)
        .slice(0, MAX_EXPLICIT_SENSITIVE_FILES);
    const files = [];
    for (const relativePath of candidates) {
        const file = await inspectWorkspaceFile(workspaceRoot, relativePath);
        if (file)
            files.push(file);
    }
    return files;
}
async function inspectWorkspaceFile(workspaceRoot, relativePath) {
    const source = resolve(workspaceRoot, relativePath);
    if (!pathWithin(workspaceRoot, source))
        return undefined;
    const before = await optionalMetadata(source);
    if (!before || !capturableExplicitFile(before))
        return undefined;
    const sourceRealPath = await realpath(source);
    if (!pathWithin(workspaceRoot, sourceRealPath))
        return undefined;
    const content = await hashFile(sourceRealPath);
    const after = await lstat(source);
    assertUnchangedSensitiveFile(before, after);
    return {
        relativePath,
        sizeBytes: content.sizeBytes,
        sha256: content.sha256,
        sensitive: isSensitiveHandoffPath(relativePath),
    };
}
async function optionalMetadata(path) {
    try {
        return await lstat(path);
    }
    catch (error) {
        if (isErrorCode(error, 'ENOENT'))
            return undefined;
        throw error;
    }
}
function capturableExplicitFile(metadata) {
    return metadata.isFile() && !metadata.isSymbolicLink();
}
async function hashFile(path) {
    const digest = createHash('sha256');
    let sizeBytes = 0;
    for await (const chunk of createReadStream(path)) {
        sizeBytes += Buffer.byteLength(chunk);
        digest.update(chunk);
    }
    return { sizeBytes, sha256: digest.digest('hex') };
}
function assertUnchangedSensitiveFile(before, after) {
    if (after.isFile() &&
        !after.isSymbolicLink() &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs) {
        return;
    }
    throw new SessionHandoffError('WORKSPACE_REVISION_STALE', 'Sensitive Workspace file changed while inspecting the handoff');
}
function safeRelativePath(path) {
    if (!path || isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path))
        return false;
    const segments = path.replaceAll('\\', '/').split('/');
    return !segments.some((segment) => {
        const lower = segment.toLowerCase();
        return (segment === '' ||
            segment === '.' ||
            segment === '..' ||
            lower === '.git' ||
            lower === '.mavis');
    });
}
function pathWithin(root, candidate) {
    const value = relative(resolve(root), resolve(candidate));
    return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}
function isErrorCode(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
//# sourceMappingURL=workspace.js.map