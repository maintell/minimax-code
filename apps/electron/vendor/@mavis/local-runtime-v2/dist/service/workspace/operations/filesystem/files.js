import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, readlink, realpath, lstat, stat, rename, unlink, mkdir, open, } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { OFFICE_PREVIEW_TOO_LARGE, officePreviewByteLimit, } from '@mavis/shared/office-preview-limits';
import { git } from '../git-process.js';
import { decodeWorkspaceText, isPathInside, isWorkspaceFileBinary, resolveWorkspaceWritePath, } from './workspace-path.js';
export const DEFAULT_MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024;
const PREVIEW_MIME_TYPES = new Map([
    ['.aac', 'audio/aac'],
    ['.bmp', 'image/bmp'],
    ['.csv', 'text/csv'],
    ['.doc', 'application/msword'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.flac', 'audio/flac'],
    ['.gif', 'image/gif'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.key', 'application/vnd.apple.keynote'],
    ['.m4a', 'audio/mp4'],
    ['.mkv', 'video/x-matroska'],
    ['.mov', 'video/quicktime'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.webp', 'image/webp'],
    ['.pdf', 'application/pdf'],
    ['.mp3', 'audio/mpeg'],
    ['.mp4', 'video/mp4'],
    ['.ogg', 'audio/ogg'],
    ['.ppt', 'application/vnd.ms-powerpoint'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['.wav', 'audio/wav'],
    ['.webm', 'video/webm'],
    ['.xls', 'application/vnd.ms-excel'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
]);
const HIDDEN_DIRS = new Set([
    '.cache',
    '.git',
    '.next',
    '.pnpm-store',
    '.turbo',
    '.venv',
    '.worktree',
    '.worktrees',
    '__pycache__',
    'build',
    'coverage',
    'dist',
    'node_modules',
    'out',
]);
export class WorkspaceFileError extends Error {
    code;
    name = 'WorkspaceFileError';
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function readTreeEntry(input) {
    const { root, directory, entry, includeHidden } = input;
    // Do not follow links while producing a workspace tree.  A symlink can
    // point outside the selected root; direct reads validate the real path, but
    // exposing its target metadata here would still leak information and make
    // the tree inconsistent with the read/write boundary.
    if (entry.isSymbolicLink() ||
        isWorkspaceTreeNoiseName(entry.name) ||
        (!includeHidden && entry.name.startsWith('.')))
        return undefined;
    const absolute = join(directory, entry.name);
    const type = fileType(entry);
    return {
        name: entry.name,
        path: toRelativePath(root, absolute),
        type,
        ...(type === 'directory' && HIDDEN_DIRS.has(entry.name) ? { ignored: true } : {}),
    };
}
function isWorkspaceTreeNoiseName(name) {
    return name === '.git' || name === '.DS_Store' || name.startsWith('._');
}
function fileType(info) {
    if (info.isDirectory())
        return 'directory';
    if (info.isFile())
        return 'file';
    return 'other';
}
function sortTreeEntries(a, b) {
    if (a.type === b.type)
        return a.name.localeCompare(b.name);
    if (a.type === 'directory')
        return -1;
    return 1;
}
export async function listWorkspaceFileTree(input) {
    const root = await existingRoot(input.workspace);
    const directory = await existingPath(root, input.path ?? '.');
    if (!directory)
        throw new WorkspaceFileError('FILE_NOT_FOUND', 'Workspace path was not found');
    const directoryStat = await withFileAccessErrors(() => stat(directory));
    if (!directoryStat.isDirectory()) {
        throw new WorkspaceFileError('NOT_A_DIRECTORY', 'Workspace path is not a directory');
    }
    const dirents = await withFileAccessErrors(() => readdir(directory, { withFileTypes: true }));
    // Directory membership is O(N); content hashing is deferred until after
    // sorting, cursor validation and page selection.
    const entries = dirents
        .map((entry) => readTreeEntry({
        root,
        directory,
        entry,
        // Preserve the V1 tree shape by including dotfiles unless the
        // caller explicitly opts out through the new flag.
        includeHidden: input.includeHidden !== false,
    }))
        .filter((entry) => entry !== undefined);
    entries.sort(sortTreeEntries);
    const snapshotId = digest(JSON.stringify({
        root,
        path: toRelativePath(root, directory),
        includeHidden: input.includeHidden !== false,
        // The cursor remains valid when a caller toggles metadata projection;
        // the directory membership/type is the stable page identity.
        entries: entries.map((entry) => [entry.path, entry.type]),
    }));
    const offset = decodeCursor(input.cursor, snapshotId);
    const limit = clamp(input.limit, 1, 200, 50);
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const projected = [];
    if (input.includeMetadata) {
        // Bound open/read/hash work even for the maximum page of 200 entries.
        for (let start = 0; start < page.length; start += 8) {
            const batch = await Promise.all(page.slice(start, start + 8).map(async (entry) => {
                return optional(async () => {
                    const absolute = join(directory, entry.name);
                    const info = await lstat(absolute);
                    if (info.isSymbolicLink() || fileType(info) !== entry.type)
                        return undefined;
                    const target = await existingPath(root, absolute);
                    if (!target)
                        return undefined;
                    return {
                        ...entry,
                        sizeBytes: info.size,
                        modifiedMs: Math.trunc(info.mtimeMs),
                        revision: await revisionForPath(target, info),
                    };
                });
            }));
            projected.push(...batch.filter((entry) => entry !== undefined));
        }
    }
    return {
        entries: input.includeMetadata ? projected : page,
        snapshotId,
        ...(nextOffset < entries.length
            ? { nextCursor: encodeCursor({ snapshotId, offset: nextOffset }) }
            : {}),
    };
}
export async function getWorkspaceFileMetadata(workspace, filePath) {
    const root = await existingRoot(workspace);
    const target = await existingPath(root, filePath);
    if (!target)
        return { exists: false, reason: 'file_not_found' };
    const info = await withFileAccessErrors(() => stat(target));
    const type = fileType(info);
    return {
        exists: true,
        type,
        sizeBytes: info.size,
        modifiedMs: Math.trunc(info.mtimeMs),
        revision: await revisionForPath(target, info),
    };
}
export async function readWorkspaceFile(workspace, filePath, options = {}, maxInlineFileBytes = DEFAULT_MAX_INLINE_FILE_BYTES) {
    const root = await existingRoot(workspace);
    const target = await existingPath(root, filePath);
    if (!target)
        throw new WorkspaceFileError('FILE_NOT_FOUND', 'File was not found');
    const info = await withFileAccessErrors(() => stat(target));
    if (!info.isFile())
        throw new WorkspaceFileError('NOT_A_FILE', 'Workspace path is not a file');
    const previewLimit = officePreviewByteLimit(filePath);
    if (previewLimit !== undefined && info.size > previewLimit) {
        throw new WorkspaceFileError(OFFICE_PREVIEW_TOO_LARGE, 'Office file exceeds the inline preview size limit');
    }
    const offset = nonNegativeInteger(options.offset, 'offset');
    const requestedLength = readLength(options);
    const maxBytes = readMaxBytes(options, maxInlineFileBytes);
    const available = Math.max(0, info.size - offset);
    const bytesToRead = Math.min(available, requestedLength, maxBytes);
    const truncated = offset + bytesToRead < info.size;
    const { bytes, classificationBytes, revision } = await readFileSnapshot(target, info, offset, bytesToRead);
    const extension = extname(filePath).toLowerCase();
    // Preview formats preserve original bytes; other files retain BOM/encoding-aware classification.
    const binary = PREVIEW_MIME_TYPES.has(extension) ||
        isWorkspaceFileBinary(filePath, classificationBytes, classificationBytes.length < info.size);
    return formatFileContent({
        bytes,
        extension,
        binary,
        raw: options.raw === true,
        partial: offset > 0 || truncated,
        sizeBytes: info.size,
        truncated,
        revision,
    });
}
export async function saveWorkspaceFile(input) {
    validateSaveInput(input);
    const target = await resolveWorkspaceFileWritePath(input.workspace, input.filePath);
    const currentInfo = await optionalFileAccess(() => stat(target));
    if (currentInfo && !currentInfo.isFile()) {
        throw new WorkspaceFileError('NOT_A_FILE', 'Workspace path is not a file');
    }
    if (input.expectedRevision !== undefined) {
        const currentRevision = currentInfo ? await revisionForPath(target, currentInfo) : undefined;
        if (input.expectedRevision !== currentRevision) {
            throw new WorkspaceFileError('REVISION_CONFLICT', 'Workspace file revision does not match');
        }
    }
    const bytes = decodeSaveContent(input);
    await withFileAccessErrors(async () => {
        if (currentInfo) {
            // rename only checks the parent directory. Confirm write access to the
            // existing file without truncating it, including OS ACL/read-only rules.
            const existing = await open(target, constants.O_WRONLY);
            await existing.close();
        }
        await mkdir(dirname(target), { recursive: true });
        await replaceFileContent(target, bytes, currentInfo ? currentInfo.mode & 0o777 : undefined);
    });
    // The committed bytes already provide the small-file revision. Reopening
    // would unnecessarily demand read permission on a valid write-only target.
    const revision = bytes.length <= DEFAULT_MAX_INLINE_FILE_BYTES
        ? digest(bytes)
        : await revisionForPath(target, await stat(target));
    return { ok: true, revision };
}
async function replaceFileContent(target, bytes, mode) {
    const temp = join(dirname(target), `.mcode-${randomBytes(8).toString('hex')}.tmp`);
    const handle = await withFileAccessErrors(() => open(temp, 'wx', 0o600));
    try {
        try {
            await handle.writeFile(bytes);
            // Creation applies umask; restore ordinary permissions after writing.
            // Never carry setuid/setgid bits to a newly authored inode.
            if (mode !== undefined)
                await handle.chmod(mode);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await withFileAccessErrors(() => rename(temp, target));
    }
    finally {
        await optional(() => unlink(temp));
    }
}
/** Canonical write identity used by the Runtime-owned file service. */
export async function resolveWorkspaceFileWritePath(workspace, filePath) {
    const root = await existingRoot(workspace);
    let target = await resolveWorkspaceWritePath(workspace, filePath);
    const links = new Set();
    for (;;) {
        if (!target)
            throw new WorkspaceFileError('PATH_TRAVERSAL', 'Path traversal denied');
        const current = target;
        const info = await optionalFileAccess(() => lstat(current));
        if (!info?.isSymbolicLink())
            return target;
        if (links.has(target) || links.size >= 40) {
            throw new WorkspaceFileError('INVALID_REQUEST', 'Too many symbolic links');
        }
        links.add(target);
        // Rename must replace the destination file, preserving the link itself.
        // Resolve missing destinations too, while keeping every parent inside the root.
        const destination = await withFileAccessErrors(() => readlink(current));
        target = await resolveWorkspaceWritePath(root, resolve(dirname(target), destination));
    }
}
export async function searchWorkspaceFiles(workspace, query, limit = 50, includeDirectories = false) {
    const needle = query.trim().toLowerCase();
    if (!needle || limit <= 0)
        return [];
    const root = await existingRoot(workspace);
    const candidates = includeDirectories
        ? [...(await mentionSearchCandidates(root))]
        : ((await gitSearchCandidates(root)) ?? (await fsSearchCandidates(root))).filter(isSearchablePath);
    const rootPath = `${root.replaceAll('\\', '/').replace(/\/$/u, '')}/`;
    const rootName = `${basename(root)}/`;
    if (includeDirectories && scorePath(rootName, needle) !== undefined) {
        candidates.push(rootPath);
    }
    return candidates
        .map((filePath) => ({
        filePath,
        score: scorePath(filePath === rootPath ? rootName : filePath, needle),
    }))
        .filter((item) => item.score !== undefined)
        .sort((a, b) => a.score - b.score || a.filePath.localeCompare(b.filePath))
        .slice(0, clamp(limit, 1, 200, 50))
        .map((item) => item.filePath);
}
/**
 * Host-scope by design: previews are keyed by absolute path because message
 * attachments and plugin assets legitimately live outside any workspace root.
 * Callers reach this only through the authenticated local socket (the remote
 * client already owns the host account over SSH), so the guards below bound
 * resource usage rather than enforce a workspace boundary.
 */
export async function previewWorkspaceFile(filePath, maxInlineFileBytes = DEFAULT_MAX_INLINE_FILE_BYTES) {
    const extension = extname(filePath).toLowerCase();
    const mimeType = PREVIEW_MIME_TYPES.get(extension);
    if (!mimeType)
        throw new WorkspaceFileError('INVALID_REQUEST', 'Only previewable binary files are supported');
    if (!isAbsolute(filePath))
        throw new WorkspaceFileError('PATH_TRAVERSAL', 'Preview path must be absolute');
    if (hasParentTraversalSegment(filePath))
        throw new WorkspaceFileError('PATH_TRAVERSAL', 'Preview path traversal denied');
    const info = await optionalFileAccess(() => stat(filePath));
    if (!info?.isFile())
        throw new WorkspaceFileError('FILE_NOT_FOUND', 'File was not found');
    if (info.size > maxInlineFileBytes)
        throw new WorkspaceFileError('FILE_TOO_LARGE', 'File content is too large for inline response');
    const bytes = await withFileAccessErrors(() => readFile(filePath));
    return { contentBase64: bytes.toString('base64'), mimeType, sizeBytes: bytes.byteLength };
}
/**
 * Host-scope by design: backs the workspace picker, which must browse
 * directories before any workspace exists. Same trust model as
 * {@link previewWorkspaceFile}.
 */
export async function listFileSystemDirectories(input) {
    const root = resolveHostPath(input.directory ?? homedir());
    const maxDepth = clamp(input.maxdepth, 1, 10, input.query ? 8 : 1);
    const offset = clamp(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = clamp(input.limit, 1, 200, 50);
    const needle = (input.query ?? '').toLowerCase();
    const entries = [];
    await walkDirectories(root, maxDepth, Boolean(input.hideDotFiles ?? true), async (absolute, info, depth) => {
        // The V1 directory picker returns children of the requested directory;
        // the root itself is context, not an entry in the result.
        if (depth === 0)
            return;
        if (!info.isDirectory() || depth > maxDepth)
            return;
        const rel = relative(root, absolute);
        if (input.hideDotFiles !== false && basename(absolute).startsWith('.'))
            return;
        if (!needle ||
            rel.toLowerCase().includes(needle) ||
            basename(absolute).toLowerCase().includes(needle)) {
            entries.push({ relative: rel ? `${rel}/` : absolute, absolute, type: 'dir' });
        }
    });
    entries.sort((a, b) => a.relative.localeCompare(b.relative));
    return { entries: entries.slice(offset, offset + limit), total: entries.length };
}
/** Host-scope by design: probes picker candidates. See {@link previewWorkspaceFile}. */
export async function getFileSystemGitInfo(path) {
    const resolvedPath = resolveHostPath(path);
    const gitPath = join(resolvedPath, '.git');
    const info = await optional(() => stat(gitPath));
    if (!info)
        return { isGitWorkspace: false, isInsideWorktree: false, hasHead: false };
    const probe = await git(['rev-parse', '--is-inside-work-tree'], resolvedPath);
    const isInsideWorktree = info.isFile();
    const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], resolvedPath)).code === 0;
    return {
        isGitWorkspace: probe.stdout.trim() === 'true' || info.isDirectory(),
        isInsideWorktree,
        hasHead,
    };
}
async function existingRoot(workspace) {
    if (!workspace.trim()) {
        throw new WorkspaceFileError('WORKSPACE_NOT_FOUND', 'Workspace directory is unavailable');
    }
    try {
        const root = await realpath(resolveHostPath(workspace));
        const info = await stat(root);
        if (!info.isDirectory())
            throw new Error('not directory');
        return root;
    }
    catch (error) {
        rethrowFileAccessDenied(error);
        throw new WorkspaceFileError('WORKSPACE_NOT_FOUND', 'Workspace directory is unavailable');
    }
}
async function existingPath(root, child) {
    const lexical = isAbsolute(child) ? resolveHostPath(child) : resolve(root, child);
    const lexicalInside = isPathInside(root, lexical);
    const target = await optionalFileAccess(() => realpath(lexical));
    if (target) {
        if (isPathInside(root, target))
            return target;
        // A lexically-contained symlink may resolve outside the workspace. Keep
        // the old read semantics (treat it as unavailable) without exposing the
        // target path; an absolute path that was already outside is traversal.
        if (lexicalInside)
            return undefined;
        throw new WorkspaceFileError('PATH_TRAVERSAL', 'Path traversal denied');
    }
    if (lexicalInside)
        return undefined;
    // `/tmp` and similar aliases can differ from the canonical workspace root
    // (for example `/var/...` vs `/private/var/...` on macOS). Resolve the
    // existing parent before rejecting an absolute path so an in-workspace
    // alias remains usable even when the leaf itself is missing.
    const parent = await optionalFileAccess(() => realpath(dirname(lexical)));
    if (parent && isPathInside(root, parent))
        return undefined;
    throw new WorkspaceFileError('PATH_TRAVERSAL', 'Path traversal denied');
}
async function revisionForPath(path, info) {
    if (!info.isFile() || info.size > DEFAULT_MAX_INLINE_FILE_BYTES) {
        return `stat:${info.size}:${Math.trunc(info.mtimeMs)}:${info.ino}`;
    }
    // Failure is not evidence of empty content. Tree projection may omit an
    // inaccessible/deleted entry; direct metadata and save callers see the error.
    const bytes = await withFileAccessErrors(() => readFile(path));
    return digest(bytes);
}
async function readFileSnapshot(filePath, info, offset, length) {
    // Small files use the same buffer for content and revision, including ranged reads.
    const complete = info.size <= DEFAULT_MAX_INLINE_FILE_BYTES;
    const content = await readRange(filePath, complete ? 0 : offset, complete ? info.size : length);
    const bytes = complete ? content.subarray(offset, offset + length) : content;
    let classificationBytes = bytes;
    if (offset !== 0 || bytes.length < Math.min(info.size, 8_000)) {
        classificationBytes = complete
            ? content.subarray(0, 8_000)
            : await readRange(filePath, 0, Math.min(info.size, 8_000));
    }
    await assertFileReadUnchanged(filePath, info, content.length, complete ? info.size : length);
    return {
        bytes,
        classificationBytes,
        revision: complete ? digest(content) : await revisionForPath(filePath, info),
    };
}
async function assertFileReadUnchanged(filePath, before, bytesRead, expectedLength) {
    const after = await optionalFileAccess(() => stat(filePath));
    if (!after ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        bytesRead !== expectedLength) {
        throw new WorkspaceFileError('REVISION_CONFLICT', 'Workspace file changed while being read');
    }
}
async function readRange(path, offset, length) {
    const handle = await withFileAccessErrors(() => open(path, 'r'));
    try {
        // Even an empty file must be opened before reporting a successful read.
        if (length <= 0)
            return Buffer.alloc(0);
        const buffer = Buffer.alloc(length);
        const result = await withFileAccessErrors(() => handle.read(buffer, 0, length, offset));
        return result.bytesRead === length ? buffer : buffer.subarray(0, result.bytesRead);
    }
    finally {
        await handle.close();
    }
}
function encodeCursor(value) {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function decodeCursor(cursor, snapshotId) {
    if (!cursor)
        return 0;
    try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (value.snapshotId !== snapshotId ||
            !Number.isSafeInteger(value.offset) ||
            (value.offset ?? -1) < 0) {
            throw new Error('cursor mismatch');
        }
        return value.offset;
    }
    catch {
        throw new WorkspaceFileError('INVALID_REQUEST', 'Invalid or stale file tree cursor');
    }
}
function digest(value) {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}
function clamp(value, min, max, fallback) {
    if (value === undefined || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
}
function nonNegativeInteger(value, name) {
    if (value === undefined)
        return 0;
    if (!Number.isSafeInteger(value) || value < 0)
        throw new WorkspaceFileError('INVALID_REQUEST', `${name} must be a non-negative integer`);
    return value;
}
function toRelativePath(root, path) {
    const value = relative(root, path).split('\\').join('/');
    return value || '.';
}
async function gitSearchCandidates(root) {
    const [tracked, deleted] = await Promise.all([
        git(['ls-files', '-co', '--exclude-standard', '-z'], root),
        git(['ls-files', '-d', '-z'], root),
    ]);
    if (tracked.code !== 0 || deleted.code !== 0)
        return undefined;
    const deletedSet = new Set(deleted.stdout.split('\0').filter(Boolean));
    return Array.from(new Set(tracked.stdout.split('\0').filter((path) => path && !deletedSet.has(path))));
}
async function searchChildDirectories(root, directory, hideDotFiles, stopAtGitBoundary = false) {
    const entries = (await optional(() => readdir(directory, { withFileTypes: true }))) ?? [];
    if (stopAtGitBoundary && directory !== root && entries.some((entry) => entry.name === '.git')) {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory() && !shouldSkipWalkEntry(entry, hideDotFiles))
        .map((entry) => `${toRelativePath(root, join(directory, entry.name))}/`);
}
async function mentionSearchCandidates(root) {
    // Detect repository membership without waiting for the entire file inventory.
    // Files and directories then scan concurrently; no stale candidate cache.
    const [gitCandidates, directories] = await Promise.all([
        gitSearchCandidates(root),
        (async () => {
            const repository = await git(['rev-parse', '--is-inside-work-tree'], root);
            return searchDirectoryCandidates(root, repository.code === 0 && repository.stdout.trim() === 'true');
        })(),
    ]);
    const files = (gitCandidates ?? (await fsSearchCandidates(root))).filter(isSearchablePath);
    return [...files, ...directories];
}
async function searchDirectoryCandidates(root, isGit) {
    const result = [];
    let pending = [root];
    // Bound keyword search to six directory levels; empty-query browsing
    // remains available for navigating deeper directories.
    for (let depth = 0; depth < 6 && pending.length > 0; depth += 1) {
        const children = [];
        // Bound filesystem concurrency instead of serializing every directory's I/O.
        // Keep nested repository roots selectable without checking their descendants
        // against the parent repository's ignore rules (Git rejects submodule paths).
        for (let offset = 0; offset < pending.length; offset += 32) {
            const batches = await Promise.all(pending
                .slice(offset, offset + 32)
                .map((directory) => searchChildDirectories(root, directory, !isGit, isGit)));
            for (const batch of batches)
                children.push(...batch);
        }
        if (children.length === 0)
            break;
        let ignored = new Set();
        if (isGit) {
            const checked = await git(['check-ignore', '--stdin', '-z'], root, {
                input: `${children.join('\0')}\0`,
            });
            // Exit 1 means no matches. On failure do not expose possibly ignored directories.
            if (checked.code !== 0 && checked.code !== 1)
                break;
            ignored = new Set(checked.stdout.split('\0').filter(Boolean));
        }
        const visible = children.filter((path) => !ignored.has(path));
        result.push(...visible);
        pending = visible.map((path) => join(root, path));
    }
    return result;
}
async function fsSearchCandidates(root) {
    const result = [];
    await walkDirectories(root, 20, true, async (absolute, info) => {
        if (info.isFile()) {
            const rel = toRelativePath(root, absolute);
            if (isSearchablePath(rel))
                result.push(rel);
        }
    });
    return result;
}
async function walkDirectories(root, maxDepth, hideDotFiles, visit) {
    const visitEntry = async (absolute, depth) => {
        const info = await optional(() => stat(absolute));
        if (!info)
            return;
        await visit(absolute, info, depth);
        if (shouldStopWalking(info, depth, maxDepth))
            return;
        const entries = (await optional(() => readdir(absolute, { withFileTypes: true }))) ?? [];
        for (const entry of entries) {
            if (shouldSkipWalkEntry(entry, hideDotFiles))
                continue;
            await visitEntry(join(absolute, entry.name), depth + 1);
        }
    };
    await visitEntry(root, 0);
}
function shouldStopWalking(info, depth, maxDepth) {
    return !info.isDirectory() || depth >= maxDepth;
}
function shouldSkipWalkEntry(entry, hideDotFiles) {
    if (entry.isSymbolicLink() || entry.name === '.git')
        return true;
    if (hideDotFiles && entry.name.startsWith('.'))
        return true;
    return HIDDEN_DIRS.has(entry.name);
}
function isSearchablePath(filePath) {
    return filePath
        .split(/[\\/]/u)
        .filter(Boolean)
        .every((segment) => !HIDDEN_DIRS.has(segment));
}
function scorePath(filePath, needle) {
    const normalized = filePath.toLowerCase();
    const name = basename(normalized);
    const stem = name.slice(0, name.length - extname(name).length);
    const index = normalized.indexOf(needle);
    if (index < 0)
        return undefined;
    const nameIndex = name.indexOf(needle);
    const segments = normalized.split('/').filter(Boolean);
    const tie = normalized.length * 0.001;
    const depth = Math.max(0, segments.length - 1);
    if (name === needle)
        return tie;
    if (stem === needle)
        return 5 + tie;
    if (name.startsWith(needle))
        return 10 + name.length + tie;
    if (nameIndex >= 0)
        return 20 + nameIndex + name.length + tie;
    const segment = segments.findIndex((item) => item.startsWith(needle));
    if (segment >= 0)
        return 40 + segment + depth + tie;
    return 80 + index + depth + tie;
}
function readLength(options) {
    return options.length === undefined
        ? Number.MAX_SAFE_INTEGER
        : nonNegativeInteger(options.length, 'length');
}
function readMaxBytes(options, maxInlineFileBytes) {
    if (options.maxBytes !== undefined) {
        nonNegativeInteger(options.maxBytes, 'maxBytes');
        if (options.maxBytes === 0) {
            throw new WorkspaceFileError('INVALID_REQUEST', 'maxBytes must be positive');
        }
    }
    return clamp(options.maxBytes ?? maxInlineFileBytes, 1, maxInlineFileBytes, maxInlineFileBytes);
}
function formatFileContent(input) {
    const { bytes, extension, binary, raw, sizeBytes, truncated, revision } = input;
    // A byte range may split a UTF-8 code point; preserve those bytes as base64.
    let validUtf8 = true;
    try {
        if (input.partial)
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        validUtf8 = false;
    }
    if (binary || raw || !validUtf8) {
        const mimeType = PREVIEW_MIME_TYPES.get(extension);
        return {
            type: binary ? 'binary' : 'text',
            content: bytes.toString('base64'),
            encoding: 'base64',
            ...(mimeType ? { mimeType } : {}),
            sizeBytes,
            truncated,
            revision,
        };
    }
    const decoded = decodeWorkspaceText(bytes);
    return {
        type: 'text',
        content: decoded.content,
        encoding: decoded.encoding,
        sizeBytes,
        truncated,
        revision,
    };
}
function validateSaveInput(input) {
    if (input.content !== undefined && input.contentBase64 !== undefined) {
        throw new WorkspaceFileError('INVALID_REQUEST', 'Provide either content or contentBase64');
    }
    if (input.content === undefined && input.contentBase64 === undefined) {
        throw new WorkspaceFileError('INVALID_REQUEST', 'File content is required');
    }
}
function decodeSaveContent(input) {
    if (input.contentBase64 !== undefined) {
        return decodeBase64Content(input.contentBase64, input.encoding, true);
    }
    if (input.encoding === undefined || input.encoding === 'utf-8' || input.encoding === 'utf8') {
        return Buffer.from(input.content ?? '', 'utf8');
    }
    if (input.encoding === 'base64') {
        return decodeBase64Content(input.content ?? '', input.encoding);
    }
    throw new WorkspaceFileError('INVALID_REQUEST', `Unsupported content encoding: ${input.encoding}`);
}
function decodeBase64Content(value, encoding, explicit = false) {
    if (explicit && encoding !== undefined && encoding !== 'base64') {
        throw new WorkspaceFileError('INVALID_REQUEST', 'contentBase64 requires base64 encoding');
    }
    if (!isValidBase64(value)) {
        throw new WorkspaceFileError('INVALID_REQUEST', 'Invalid base64 content');
    }
    return Buffer.from(value, 'base64');
}
function isValidBase64(value) {
    if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value))
        return false;
    const decoded = Buffer.from(value, 'base64').toString('base64');
    return decoded === value || (value.indexOf('=') < 0 && decoded.replace(/=+$/u, '') === value);
}
async function optional(operation) {
    try {
        return await operation();
    }
    catch {
        return undefined;
    }
}
function rethrowFileAccessDenied(error) {
    if (error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'EACCES' || error.code === 'EPERM')) {
        throw new WorkspaceFileError('FILE_ACCESS_DENIED', 'Permission denied while accessing workspace file');
    }
}
async function withFileAccessErrors(operation) {
    try {
        return await operation();
    }
    catch (error) {
        rethrowFileAccessDenied(error);
        throw error;
    }
}
// Requested paths must distinguish denied access from absence. Tree/search
// traversal and best-effort cleanup deliberately retain optional() semantics.
async function optionalFileAccess(operation) {
    try {
        return await operation();
    }
    catch (error) {
        rethrowFileAccessDenied(error);
        return undefined;
    }
}
function resolveHostPath(input) {
    let value = input.startsWith('~') ? join(homedir(), input.slice(1)) : input;
    // Keep parity with the V1 path utility for Git Bash callers on Windows.
    // `path.resolve('/c/Users/...')` otherwise treats `c` as a directory on the
    // current drive instead of the requested Windows drive.
    if (process.platform === 'win32') {
        const msysMatch = value.match(/^\/([a-zA-Z])(\/.*)?$/u);
        if (msysMatch) {
            const drive = (msysMatch[1] ?? '').toUpperCase();
            const rest = msysMatch[2]?.replace(/\//g, '\\') ?? '\\';
            value = `${drive}:${rest}`;
        }
    }
    return resolve(value);
}
function hasParentTraversalSegment(value) {
    return value.split(/[\\/]+/u).some((segment) => segment === '..');
}
//# sourceMappingURL=files.js.map