import { execFile as execFileCallback } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { addParentDirectories, scoreFileSearchCandidate } from './search-candidates.js';
import { mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, win32, } from 'node:path';
import { promisify, TextDecoder } from 'node:util';
import { Readable } from 'node:stream';
import { getWorkspaceImagePreviewMimeType } from '@mavis/shared/media-asset-meta';
import { OFFICE_PREVIEW_TOO_LARGE, officePreviewByteLimit, } from '@mavis/shared/office-preview-limits';
import { TEXT_PREVIEW_MAX_BYTES, TEXT_PREVIEW_TOO_LARGE } from '@mavis/shared/text-preview-limits';
import { OfficePreviewSizeError, readOfficePreviewFile } from './office-preview-read.js';
import { MAX_OPEN_FORMAT_PREVIEW_BYTES, readOpenFormatFile } from './open-format-read.js';
import { getDataDir } from '@mavis/config';
import { LocalReviewLinkStore } from '../review-link/store.js';
import { generateDefaultWorktreeBranch } from '../worktrees/branch.js';
import { IdeLauncher, IdeLauncherError } from '../ide/launcher.js';
import { git as runGitProcess, gitRoot } from './git-process.js';
import { resolvePath, toPortableRelativePath } from './path-utils.js';
import { routeFileSave } from './save.js';
import { classifyExistingPathError } from './path-error.js';
import { listWorkspaceGitWorktrees } from './worktrees.js';
import { buildWorkspaceFileThumbnail, normalizeThumbnailMaxEdge, resetWorkspaceFileThumbnailCache, } from './thumbnail.js';
import { logger } from '../common/logger.js';
import { WorkspaceGitChangesCoordinator, } from './workspace-git-changes-coordinator.js';
const execFile = promisify(execFileCallback);
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const VIDEO_PREVIEW_MIME_TYPES = new Map([
    ['.m4v', 'video/x-m4v'],
    ['.mkv', 'video/x-matroska'],
    ['.mov', 'video/quicktime'],
    ['.mp4', 'video/mp4'],
    ['.ogv', 'video/ogg'],
    ['.webm', 'video/webm'],
]);
const RC_REQUEST_SOURCE_HEADER = 'X-MCode-Request-Source';
const RC_REQUEST_SOURCE_VALUE = 'remote-control';
const RC_FILE_CONTENT_MAX_BYTES_HEADER = 'X-MCode-Remote-Control-File-Content-Max-Bytes';
const DEFAULT_RC_FILE_CONTENT_MAX_BYTES = 10 * 1024 * 1024;
// Keep aligned with UI open-format-policy.ts. Text diagrams and RFC 822 mail
// retain the existing text path; these formats require their original bytes.
const OPEN_FORMAT_BINARY_EXTENSIONS = new Set('zip rar 7z tar gz tgz bz2 xz ttf otf woff woff2 eot psd psb ai eps ps webarchive sqlite sqlite3 db wasm parquet avro xmind epub ofd xps oxps msg'
    .split(' ')
    .map((extension) => `.${extension}`));
const TEXT_EXTENSIONS = new Set([
    '.css',
    '.csv',
    '.html',
    '.js',
    '.json',
    '.jsonl',
    '.jsx',
    '.log',
    '.md',
    '.mdx',
    '.mjs',
    '.scss',
    '.sh',
    '.ts',
    '.tsx',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
]);
const PREVIEW_BINARY_MIME_TYPES = new Map([
    ['.aac', 'audio/aac'],
    ['.bmp', 'image/bmp'],
    // Workbook saves compare the original file hash, including CSV encoding/BOM.
    ['.csv', 'text/csv'],
    ['.doc', 'application/msword'],
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.flac', 'audio/flac'],
    ['.gif', 'image/gif'],
    ['.key', 'application/vnd.apple.keynote'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.m4a', 'audio/mp4'],
    ['.mkv', 'video/x-matroska'],
    ['.mov', 'video/quicktime'],
    ['.mp3', 'audio/mpeg'],
    ['.mp4', 'video/mp4'],
    ['.ogg', 'audio/ogg'],
    ['.pdf', 'application/pdf'],
    ['.png', 'image/png'],
    ['.ppt', 'application/vnd.ms-powerpoint'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['.svg', 'image/svg+xml'],
    ['.wav', 'audio/wav'],
    ['.webm', 'video/webm'],
    ['.webp', 'image/webp'],
    ['.xls', 'application/vnd.ms-excel'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
]);
const BINARY_EXTENSIONS = new Set([
    '.7z',
    '.aac',
    '.bin',
    '.bmp',
    '.db',
    '.doc',
    '.docx',
    '.dylib',
    '.exe',
    '.flac',
    '.gz',
    '.key',
    '.m4a',
    '.mkv',
    '.mov',
    '.mp3',
    '.mp4',
    '.ogg',
    '.pdf',
    '.png',
    '.ppt',
    '.pptx',
    '.so',
    '.sqlite',
    '.tar',
    '.wasm',
    '.wav',
    '.webm',
    '.webp',
    '.xls',
    '.xlsx',
    '.xlsm',
    '.zip',
]);
const HIDDEN_SEARCH_DIRS = new Set([
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
/** Read-only process-local Git metadata facade; mutation remains outside this seam. */
export function createLocalWorkspaceGitFacade(reviewLinkStore = new LocalReviewLinkStore(getDataDir)) {
    return {
        getMetadata: (workspace) => getGitMetadata(workspace),
        getReviewLink: async (workspace, branch) => {
            const entry = reviewLinkStore.read(workspace, branch);
            // Widened to the facade's untyped shape; the consumer re-validates it
            // rather than trusting a structural cast across the seam.
            return entry ? { ...entry } : undefined;
        },
    };
}
let ideLauncher = new IdeLauncher();
let gitCommandRunner = runGitProcess;
const defaultOpenCommandRuntime = {
    platform: process.platform,
    env: process.env,
    run: async (file, args, options) => {
        await execFile(file, args, options);
    },
};
let openCommandRuntime = defaultOpenCommandRuntime;
export function createLocalFileApiGitChangesCoordinator() {
    return new WorkspaceGitChangesCoordinator(captureGitChangesBase, enrichGitChanges);
}
const defaultGitChangesCoordinator = createLocalFileApiGitChangesCoordinator();
export function __setLocalFileApiIdeLauncherForTests(nextLauncher) {
    ideLauncher = nextLauncher ?? new IdeLauncher();
}
export function __setLocalFileApiGitCommandRunnerForTests(nextRunner) {
    gitCommandRunner = nextRunner ?? runGitProcess;
    defaultGitChangesCoordinator.clear();
}
export function __resetFileThumbnailCacheForTests() {
    resetWorkspaceFileThumbnailCache();
}
export function __setLocalFileApiOpenCommandForTests(nextRuntime) {
    openCommandRuntime = nextRuntime
        ? { ...defaultOpenCommandRuntime, ...nextRuntime }
        : defaultOpenCommandRuntime;
}
export async function routeLocalFileApi(request, parts, url, metrics, gitChangesCoordinator = defaultGitChangesCoordinator) {
    const method = request.method.toUpperCase();
    if (parts[0] === 'file') {
        return routeFileApi(method, request, parts.slice(1).join('/'), url, gitChangesCoordinator, metrics);
    }
    if (parts[0] === 'fs') {
        return routeFsApi(method, parts.slice(1).join('/'), url);
    }
    return undefined;
}
async function routeFileApi(method, request, tail, url, gitChangesCoordinator, metrics) {
    if (method === 'GET' && tail === 'tree') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const subPath = url.searchParams.get('path') ?? '.';
        return json(await listFileTree(workspace, subPath));
    }
    if (method === 'GET' && tail === 'info') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const filePath = requiredQuery(url, 'path');
        if (filePath instanceof Response)
            return filePath;
        const resolved = await resolveExistingWorkspacePath(workspace, filePath);
        if (!resolved.ok) {
            if (resolved.code === 'NOT_FOUND') {
                return json({ exists: false, reason: 'file_not_found' });
            }
            if (resolved.code === 'WORKSPACE_NOT_FOUND') {
                return json({ exists: false, reason: 'workspace_not_found' });
            }
            return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
        }
        const targetStat = await stat(resolved.absolute);
        return json({
            exists: true,
            type: targetStat.isFile() ? 'file' : targetStat.isDirectory() ? 'directory' : 'other',
            sizeBytes: targetStat.size,
            modifiedAtMs: targetStat.mtimeMs,
        });
    }
    if (method === 'GET' && tail === 'content') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const filePath = requiredQuery(url, 'path');
        if (filePath instanceof Response)
            return filePath;
        const fileTooLarge = await remoteControlFileContentLimitResponse(request.headers, workspace, filePath, metrics, 'content');
        if (fileTooLarge)
            return fileTooLarge;
        const { value: content } = await readWorkspaceFileOutcome(workspace, filePath, TEXT_PREVIEW_MAX_BYTES);
        return json(content, content.code === OFFICE_PREVIEW_TOO_LARGE || content.code === TEXT_PREVIEW_TOO_LARGE
            ? { status: 413 }
            : undefined);
    }
    if (method === 'GET' && tail === 'thumbnail') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const filePath = requiredQuery(url, 'path');
        if (filePath instanceof Response)
            return filePath;
        const resolved = await resolveExistingWorkspacePath(workspace, filePath);
        if (!resolved.ok) {
            return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
        }
        const thumbnail = await buildWorkspaceFileThumbnail(resolved.absolute, normalizeThumbnailMaxEdge(url.searchParams.get('maxEdge')), url.searchParams.get('preserveAlpha') === '1');
        if (!thumbnail.ok) {
            return json({ error: thumbnail.error, code: thumbnail.code }, { status: thumbnail.status });
        }
        return new Response(Uint8Array.from(thumbnail.bytes), {
            headers: {
                'Content-Type': thumbnail.mimeType,
                'Content-Length': String(thumbnail.bytes.byteLength),
                'Cache-Control': 'private, no-store',
                'X-MCode-Thumbnail-Cache': thumbnail.cache,
            },
        });
    }
    if (method === 'GET' && tail === 'media') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const filePath = requiredQuery(url, 'path');
        if (filePath instanceof Response)
            return filePath;
        const resolved = await resolveExistingWorkspacePath(workspace, filePath);
        if (!resolved.ok) {
            return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
        }
        const contentType = VIDEO_PREVIEW_MIME_TYPES.get(extname(resolved.absolute).toLowerCase()) ??
            getWorkspaceImagePreviewMimeType(resolved.absolute);
        if (!contentType) {
            return json({ error: 'Media preview format is not supported', code: 'MEDIA_PREVIEW_UNSUPPORTED' }, { status: 415 });
        }
        return streamWorkspaceMedia(resolved.absolute, contentType, request.headers.get('range'));
    }
    if (method === 'GET' && tail === 'preview') {
        return serveFilePreview(url, request.headers, metrics);
    }
    if (method === 'GET' && tail === 'diff') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const filePath = requiredQuery(url, 'path');
        if (filePath instanceof Response)
            return filePath;
        const scope = readGitDiffScope(url.searchParams.get('scope'));
        const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0;
        const content = await readWorkspaceFileForDiffScope(workspace, filePath, scope);
        const diff = await git(gitDiffArgs(scope, hasHead, [filePath]), workspace);
        const addedDiff = diff.stdout.trim()
            ? undefined
            : scope === 'staged'
                ? undefined
                : await buildAddedFileDiff(workspace, filePath);
        const binary = diff.stdout.trim()
            ? isBinaryDiff(diff.stdout)
            : scope === 'staged'
                ? false
                : await isUntrackedBinaryFile(workspace, filePath);
        return json({
            ...content,
            ...(scope !== 'all' ? { changeScope: scope } : {}),
            ...(binary
                ? { previewState: 'binary' }
                : diff.code === 0 && diff.stdout.trim()
                    ? { diff: diff.stdout, previewState: 'ready' }
                    : addedDiff
                        ? { diff: addedDiff.diff, previewState: 'ready' }
                        : {}),
        });
    }
    if (method === 'GET' && tail === 'diff-context') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const filePath = requiredQuery(url, 'path');
        if (filePath instanceof Response)
            return filePath;
        const context = await readDiffContext(workspace, filePath, readGitDiffScope(url.searchParams.get('scope')));
        return context
            ? json(context)
            : json({ error: 'Diff context is not available', code: 'DIFF_CONTEXT_UNAVAILABLE' }, { status: 422 });
    }
    if (method === 'GET' && tail === 'diffs') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const scope = readGitDiffScope(url.searchParams.get('scope'));
        const changes = await getGitChanges(workspace, 'full', gitChangesCoordinator);
        const requestedScopes = gitDiffScopes(scope);
        const diffBlocksByScope = new Map();
        await Promise.all(requestedScopes.map(async (diffScope) => {
            const diff = await git(gitDiffArgs(diffScope, changes.hasHead), workspace);
            diffBlocksByScope.set(diffScope, splitDiffBlocksByFile(diff.stdout));
        }));
        const files = changes.files.filter((file) => file.changeScope && requestedScopes.includes(file.changeScope));
        return json(await Promise.all(files.map(async (file) => {
            const fileScope = file.changeScope;
            const block = diffBlocksByScope.get(fileScope)?.get(file.path);
            const addedDiff = block || fileScope === 'staged'
                ? undefined
                : await buildAddedFileDiff(workspace, file.path);
            const diffText = block ?? addedDiff?.diff;
            const binary = block
                ? isBinaryDiff(block)
                : fileScope === 'staged'
                    ? false
                    : await isUntrackedBinaryFile(workspace, file.path);
            return {
                file: file.path,
                ...(file.originalPath ? { originalPath: file.originalPath } : {}),
                additions: file.additions || addedDiff?.additions || 0,
                deletions: file.deletions,
                status: file.status,
                changeScope: fileScope,
                ...(binary
                    ? { previewState: 'binary' }
                    : diffText
                        ? { diff: diffText, previewState: 'ready' }
                        : { previewState: 'no_diff' }),
            };
        })));
    }
    if (method === 'GET' && tail === 'status') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const changes = await getGitChanges(workspace, 'full', gitChangesCoordinator);
        return json(changes.files.map((file) => ({
            path: file.path,
            ...(file.originalPath ? { originalPath: file.originalPath } : {}),
            added: file.additions,
            removed: file.deletions,
            status: file.status,
            ...(file.changeScope ? { changeScope: file.changeScope } : {}),
        })));
    }
    if (tail.startsWith('git/')) {
        return routeGitApi(method, request, tail.slice('git/'.length), url, gitChangesCoordinator);
    }
    if (method === 'GET' && tail === 'search') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const query = requiredQuery(url, 'query');
        if (query instanceof Response)
            return query;
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
        return json(await searchFiles(workspace, query, Number.isFinite(limit) ? limit : 50, url.searchParams.get('includeDirectories') === 'true'));
    }
    if (method === 'GET' && tail === 'open-app') {
        return json(null);
    }
    if (method === 'GET' && tail === 'ide-apps') {
        return json(await ideLauncher.listIdeApps());
    }
    if (method === 'POST' && tail === 'open') {
        const body = await readJsonBody(request);
        const target = await resolveBodyPath(body);
        if (target instanceof Response)
            return target;
        return runOpenCommand('open', target.absolute);
    }
    if (method === 'POST' && tail === 'reveal') {
        const body = await readJsonBody(request);
        const target = await resolveBodyPath(body);
        if (target instanceof Response)
            return target;
        return runOpenCommand('reveal', target.absolute);
    }
    if (method === 'POST' && tail === 'open-in-ide') {
        const body = await readJsonBody(request);
        const ideId = readString(body, 'ideId');
        const workspace = readString(body, 'workspace');
        const filePath = readString(body, 'path');
        if (!ideId)
            return json({ error: 'ideId is required' }, { status: 400 });
        if (!workspace && !filePath) {
            return json({ error: 'workspace or path is required' }, { status: 400 });
        }
        if (body['fileOnly'] !== undefined && typeof body['fileOnly'] !== 'boolean') {
            return json({ error: 'fileOnly must be a boolean' }, { status: 400 });
        }
        const fileOnly = body['fileOnly'] === true;
        if (fileOnly && !filePath) {
            return json({ error: 'path is required for fileOnly' }, { status: 400 });
        }
        try {
            await ideLauncher.openWorkspaceInIde(workspace, ideId, filePath, fileOnly);
            return json({ ok: true });
        }
        catch (error) {
            return ideLauncherErrorResponse(error);
        }
    }
    if (method === 'POST' && tail === 'save') {
        return routeFileSave(request, { readJsonBody, resolveBodyPath, readString, json });
    }
    if (method === 'POST' && tail === 'commit-message') {
        const body = await readJsonBody(request);
        const workspace = readString(body, 'workspace');
        if (!workspace)
            return json({ error: 'workspace is required' }, { status: 400 });
        const changes = await getGitChanges(workspace, 'full', gitChangesCoordinator);
        if (!changes.isGitRepo)
            return json({ error: 'Not a git repository' }, { status: 400 });
        if (changes.changedFiles === 0)
            return json({ error: 'No changes to summarize' }, { status: 400 });
        const first = changes.files[0];
        const action = first?.status === 'added' ? 'add' : first?.status === 'deleted' ? 'remove' : 'update';
        return json({
            message: `chore: ${action} ${first ? basename(first.path) : 'workspace files'}`,
        });
    }
    return notFound(`/file/${tail}`);
}
async function streamWorkspaceMedia(absolutePath, contentType, rangeHeader) {
    const info = await stat(absolutePath);
    if (!info.isFile())
        return json({ error: 'File not found', code: 'NOT_FOUND' }, { status: 404 });
    const range = parseSingleByteRange(rangeHeader, info.size);
    if (rangeHeader && !range) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' },
        });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, info.size - 1);
    const stream = createReadStream(absolutePath, { start, end });
    return new Response(Readable.toWeb(stream), {
        status: range ? 206 : 200,
        headers: {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'private, no-store',
            'Content-Length': String(Math.max(0, end - start + 1)),
            'Content-Type': contentType,
            'X-Content-Type-Options': 'nosniff',
            ...(contentType === 'image/svg+xml'
                ? {
                    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
                }
                : {}),
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
        },
    });
}
function parseSingleByteRange(value, size) {
    if (!value)
        return null;
    const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
    if (!match || size <= 0)
        return null;
    const startText = match[1] ?? '';
    const endText = match[2] ?? '';
    if (!startText && !endText)
        return null;
    if (!startText) {
        const suffixLength = Number(endText);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0)
            return null;
        return { start: Math.max(0, size - suffixLength), end: size - 1 };
    }
    const start = Number(startText);
    const requestedEnd = endText ? Number(endText) : size - 1;
    if (!Number.isSafeInteger(start) ||
        !Number.isSafeInteger(requestedEnd) ||
        start < 0 ||
        start >= size ||
        requestedEnd < start) {
        return null;
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
}
function ideLauncherErrorResponse(error) {
    if (error instanceof IdeLauncherError) {
        return json({ error: error.message, code: error.code }, { status: error.status });
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
}
async function serveFilePreview(url, headers, metrics) {
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response)
        return filePath;
    if (filePath.includes('..')) {
        return json({ error: 'Path traversal not allowed' }, { status: 403 });
    }
    const contentType = getWorkspaceImagePreviewMimeType(filePath);
    if (!contentType) {
        return json({ error: 'Only image files are allowed' }, { status: 403 });
    }
    try {
        const info = await stat(filePath);
        if (!info.isFile())
            return json({ error: 'File not found' }, { status: 404 });
        const fileTooLarge = remoteControlFileSizeLimitResponse(headers, info.size, metrics, 'preview');
        if (fileTooLarge)
            return fileTooLarge;
        const data = await readFile(filePath);
        const body = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        return new Response(body, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'private, max-age=300',
            },
        });
    }
    catch {
        return json({ error: 'File not found' }, { status: 404 });
    }
}
async function routeFsApi(method, tail, url) {
    if (method === 'GET' && tail === 'dirs') {
        const directory = url.searchParams.get('directory') || homedir();
        const query = url.searchParams.get('query') ?? '';
        const maxdepth = clampInt(url.searchParams.get('maxdepth'), query ? 8 : 1, 1, 10);
        const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
        const hideDotFiles = url.searchParams.get('hideDotFiles') !== 'false';
        return json(await listDirs(directory, query, maxdepth, offset, limit, hideDotFiles));
    }
    if (method === 'GET' && tail === 'git-info') {
        const targetPath = requiredQuery(url, 'path');
        if (targetPath instanceof Response)
            return targetPath;
        const gitFile = resolve(targetPath, '.git');
        try {
            const info = await stat(gitFile);
            const isInsideWorktree = info.isFile();
            const hasHead = await probeGitWorkspaceHasHead(gitFile, info);
            return json({ isGitWorkspace: true, isInsideWorktree, hasHead });
        }
        catch {
            return json({ isGitWorkspace: false, isInsideWorktree: false, hasHead: false });
        }
    }
    return notFound(`/fs/${tail}`);
}
/**
 * Pure-fs probe for whether the workspace at `.git` has a resolvable HEAD
 * commit. Returns `false` for the unborn case (`git init` with no
 * commits — HEAD points to `refs/heads/<branch>` but the ref file does
 * not exist yet, so `git worktree add main` would fail with
 * `fatal: invalid reference: main` and BranchPill's base-ref picker
 * would be empty).
 *
 * Stays in-process (no `git` subprocess) so the render-gate probe path
 * keeps the same lightweight semantics as the existing `stat(.git)`
 * probe.
 *
 * @param gitFilePath  resolved path to the workspace's `.git`
 * @param gitFileInfo  stat() of `gitFilePath` — directory (main checkout)
 *                     vs. file (worktree gitlink) decides which gitdir
 *                     houses HEAD.
 */
async function probeGitWorkspaceHasHead(gitFilePath, gitFileInfo) {
    try {
        let gitDir;
        if (gitFileInfo.isDirectory()) {
            gitDir = gitFilePath;
        }
        else if (gitFileInfo.isFile()) {
            // worktree gitlink: ".git" contains "gitdir: <path-to-real-gitdir>".
            const linkContent = (await readFile(gitFilePath, 'utf8')).trim();
            const linkMatch = linkContent.match(/^gitdir:\s*(.+)$/m);
            const linkedDir = linkMatch?.[1]?.trim();
            if (!linkedDir)
                return false;
            gitDir = isAbsolute(linkedDir) ? linkedDir : resolve(dirname(gitFilePath), linkedDir);
        }
        else {
            return false;
        }
        const headContent = (await readFile(resolve(gitDir, 'HEAD'), 'utf8')).trim();
        // Detached HEAD: 40-64 hex chars (sha1/sha256). Always backed by an
        // object, so any commit at all means hasHead=true.
        if (/^[0-9a-f]{40,64}$/i.test(headContent))
            return true;
        const symMatch = headContent.match(/^ref:\s*(.+)$/);
        const refName = symMatch?.[1]?.trim();
        if (!refName)
            return false;
        // For linked worktrees, refs live under the main gitdir (resolved via
        // the `commondir` file). For a top-level gitdir, commondir is absent
        // (or `.`).
        let refsBaseDir = gitDir;
        try {
            const commonRel = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
            if (commonRel) {
                refsBaseDir = isAbsolute(commonRel) ? commonRel : resolve(gitDir, commonRel);
            }
        }
        catch {
            // No `commondir` → main checkout. Keep `refsBaseDir = gitDir`.
        }
        try {
            // Loose ref: <gitdir>/refs/heads/<branch> exists as a regular file.
            const looseInfo = await stat(resolve(refsBaseDir, refName));
            if (looseInfo.isFile())
                return true;
        }
        catch {
            // Loose ref missing → fall through to packed-refs.
        }
        try {
            const packed = await readFile(resolve(refsBaseDir, 'packed-refs'), 'utf8');
            for (const line of packed.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^'))
                    continue;
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 2 && parts[1] === refName)
                    return true;
            }
        }
        catch {
            // No packed-refs file → fall through.
        }
        return false;
    }
    catch {
        // Any unexpected probe error (permission denied, unreadable HEAD,
        // partial git layout) is treated as "no HEAD yet" — the conservative
        // default that disables `git worktree add` rather than enabling it
        // against an unverified ref.
        return false;
    }
}
async function routeGitApi(method, request, tail, url, gitChangesCoordinator) {
    if (method === 'GET' && tail === 'probe') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        return json({ isGitRepo: await isGitRepo(workspace) });
    }
    if (method === 'GET' && tail === 'changes') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const mode = url.searchParams.get('mode') === 'fast' ? 'fast' : 'full';
        return json(await getGitChanges(workspace, mode, gitChangesCoordinator));
    }
    if (method === 'GET' && tail === 'metadata') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        return json(await getGitMetadata(workspace));
    }
    if (method === 'GET' && tail === 'branches') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const includeRemote = url.searchParams.get('includeRemote') === 'true';
        return json(await getGitBranches(workspace, includeRemote));
    }
    if (method === 'GET' && tail === 'branch-picker') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        const [branchInfo, worktreeInfo] = await Promise.all([
            getGitBranches(workspace, false),
            listWorkspaceGitWorktrees(workspace),
        ]);
        if (!branchInfo.success)
            return json(branchInfo);
        return json({
            success: true,
            current: branchInfo.current,
            branches: branchInfo.branches,
            local: branchInfo.local,
            worktrees: Array.isArray(worktreeInfo.worktrees) ? worktreeInfo.worktrees : [],
        });
    }
    if (method === 'GET' && tail === 'default-branch') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        return json(await getDefaultBranch(workspace));
    }
    if (method === 'POST' && tail === 'checkout') {
        const body = await readJsonBody(request);
        const invalid = await validateGitBranchBody(body);
        if (invalid)
            return invalid;
        return json(await gitMutation(body, ['checkout', readString(body, 'branch')], gitChangesCoordinator));
    }
    if (method === 'POST' && tail === 'create-branch') {
        const body = await readJsonBody(request);
        const invalid = await validateGitBranchBody(body);
        if (invalid)
            return invalid;
        return json(await gitMutation(body, ['checkout', '-b', readString(body, 'branch')], gitChangesCoordinator));
    }
    if (method === 'POST' && tail === 'commit') {
        const body = await readJsonBody(request);
        const message = readString(body, 'message');
        if (!message)
            return json({ success: false, error: 'message is required' }, { status: 400 });
        const workspace = readString(body, 'workspace');
        if (!workspace)
            return json({ success: false, error: 'workspace is required' }, { status: 400 });
        const result = await withGitChangesInvalidation(workspace, gitChangesCoordinator, async () => {
            if (body.includeUnstaged !== false) {
                await git(['add', '--all'], workspace);
            }
            return await git(['commit', '-m', message], workspace);
        });
        return json(toMutationResult(result));
    }
    if (method === 'POST' && tail === 'push') {
        const body = await readJsonBody(request);
        const workspace = readString(body, 'workspace');
        if (!workspace)
            return json({ success: false, error: 'workspace is required' }, { status: 400 });
        const result = await git(['push'], workspace);
        if (result.code !== 0 &&
            /no upstream branch|set-upstream|--set-upstream/i.test(result.stderr)) {
            return json(toMutationResult(await git(['push', '-u', 'origin', 'HEAD'], workspace)));
        }
        return json(toMutationResult(result));
    }
    if (method === 'POST' && tail === 'change-action') {
        const body = await readJsonBody(request);
        return json(await applyGitFileChangeAction(body, gitChangesCoordinator));
    }
    if (method === 'GET' && tail === 'worktrees') {
        const workspace = requiredQuery(url, 'workspace');
        if (workspace instanceof Response)
            return workspace;
        return json(await listWorkspaceGitWorktrees(workspace));
    }
    if (method === 'POST' && tail === 'worktrees') {
        const body = await readJsonBody(request);
        const workspace = readString(body, 'workspace');
        if (!workspace)
            return json({ success: false, error: 'workspace is required' }, { status: 400 });
        const options = readRecord(body, 'options') ?? {};
        const branch = readString(options, 'branch') ?? generateDefaultWorktreeBranch();
        const invalidBranch = await validateGitBranch(workspace, branch);
        if (invalidBranch)
            return invalidBranch;
        const dirName = readString(options, 'dirName') ?? branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
        const base = readString(options, 'base') ?? 'HEAD';
        const workspaceRoot = await gitRoot(workspace);
        if (!workspaceRoot)
            return json({ success: false, error: 'Not a git repository' }, { status: 400 });
        const worktreeDir = await resolveWorktreeTarget(workspaceRoot, dirName);
        if (!worktreeDir) {
            return json({ success: false, error: 'Invalid worktree dirName' }, { status: 400 });
        }
        const result = await git(['worktree', 'add', '-b', branch, worktreeDir, base], workspaceRoot);
        return json(result.code === 0
            ? { success: true, worktreeDir, branch, resolvedBase: base }
            : { success: false, error: result.stderr || result.stdout });
    }
    if (method === 'POST' && tail === 'worktrees/remove') {
        const body = await readJsonBody(request);
        const workspace = readString(body, 'workspace');
        const worktreeDir = readString(body, 'worktreeDir');
        if (!workspace)
            return json({ success: false, error: 'workspace is required' }, { status: 400 });
        if (!worktreeDir)
            return json({ success: false, error: 'worktreeDir is required' }, { status: 400 });
        return json(toMutationResult(await git(['worktree', 'remove', worktreeDir], workspace)));
    }
    return notFound(`/file/git/${tail}`);
}
export async function listFileTree(workspace, subPath) {
    const root = resolveWorkspace(workspace);
    const realRoot = await realpath(root).catch(() => undefined);
    if (!realRoot)
        return [];
    const dir = await resolveWorkspacePath(workspace, subPath);
    if (!dir)
        return [];
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const relativeBase = relative(realRoot, dir);
    return entries
        .filter((entry) => entry.name !== '.git')
        .map((entry) => {
        const nodePath = !relativeBase || relativeBase === '.' ? entry.name : join(relativeBase, entry.name);
        return {
            name: entry.name,
            path: toPortableRelativePath(nodePath),
            type: entry.isDirectory() ? 'directory' : 'file',
            ignored: entry.isDirectory() && HIDDEN_SEARCH_DIRS.has(entry.name),
        };
    })
        .sort((a, b) => {
        if (a.type !== b.type)
            return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}
async function readWorkspaceFile(workspace, filePath) {
    return (await readWorkspaceFileOutcome(workspace, filePath)).value;
}
async function readWorkspaceFileOutcome(workspace, filePath, 
// Only inline content previews opt in; Git diff and line statistics keep their read contract.
textPreviewMaxBytes) {
    const absolute = await resolveWorkspacePath(workspace, filePath);
    if (!absolute) {
        return {
            value: { type: 'binary', content: '', error: 'Path traversal denied' },
            readSucceeded: false,
        };
    }
    const ext = extname(filePath).toLowerCase();
    const isOpenFormatBinary = OPEN_FORMAT_BINARY_EXTENSIONS.has(ext);
    const previewBinaryMime = isOpenFormatBinary
        ? 'application/octet-stream'
        : PREVIEW_BINARY_MIME_TYPES.get(ext);
    const previewLimit = officePreviewByteLimit(filePath);
    const readBytes = () => previewLimit === undefined ? readFile(absolute) : readOfficePreviewFile(absolute, previewLimit);
    if (previewBinaryMime) {
        try {
            const bytes = isOpenFormatBinary
                ? await readOpenFormatFile(absolute, ext, textPreviewMaxBytes !== undefined)
                : await readBytes();
            // PostScript may be editable source, including legacy Illustrator files.
            // Raw-byte preview support must not change text diff/edit classification.
            if (ext === '.ps' ||
                ext === '.eps' ||
                (ext === '.ai' && bytes.subarray(0, 4).toString() === '%!PS')) {
                const text = decodeUtf16TextBytes(bytes) ??
                    (isProbablyBinary(bytes) ? undefined : bytes.toString('utf-8'));
                if (text !== undefined) {
                    if (textPreviewMaxBytes !== undefined && bytes.byteLength > textPreviewMaxBytes) {
                        return oversizedPreviewOutcome(new OfficePreviewSizeError(bytes.byteLength, textPreviewMaxBytes), 'text');
                    }
                    return {
                        value: {
                            type: 'text',
                            content: text,
                            ...(textPreviewMaxBytes !== undefined ? { sizeBytes: bytes.byteLength } : {}),
                        },
                        readSucceeded: true,
                    };
                }
            }
            const oversized = isOpenFormatBinary && bytes.byteLength > MAX_OPEN_FORMAT_PREVIEW_BYTES;
            return {
                value: {
                    type: 'binary',
                    content: oversized ? '' : bytes.toString('base64'),
                    ...(oversized ? { error: 'preview_too_large' } : { encoding: 'base64' }),
                    mimeType: previewBinaryMime,
                },
                readSucceeded: true,
            };
        }
        catch (error) {
            if (error instanceof OfficePreviewSizeError) {
                if (previewLimit !== undefined)
                    return oversizedPreviewOutcome(error);
                return {
                    value: {
                        type: 'binary',
                        content: '',
                        mimeType: previewBinaryMime,
                        error: 'preview_too_large',
                    },
                    readSucceeded: true,
                };
            }
            return {
                value: { type: 'binary', content: '', mimeType: previewBinaryMime },
                readSucceeded: false,
            };
        }
    }
    if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext)) {
        return { value: { type: 'binary', content: '' }, readSucceeded: true };
    }
    try {
        const bytes = textPreviewMaxBytes === undefined
            ? await readBytes()
            : await readOfficePreviewFile(absolute, textPreviewMaxBytes);
        const utf16Text = decodeUtf16TextBytes(bytes);
        if (utf16Text !== undefined) {
            return {
                value: {
                    type: 'text',
                    content: utf16Text,
                    ...(textPreviewMaxBytes !== undefined ? { sizeBytes: bytes.byteLength } : {}),
                },
                readSucceeded: true,
            };
        }
        if (!TEXT_EXTENSIONS.has(ext) && isProbablyBinary(bytes)) {
            return { value: { type: 'binary', content: '' }, readSucceeded: true };
        }
        return {
            value: {
                type: 'text',
                content: bytes.toString('utf-8'),
                ...(textPreviewMaxBytes !== undefined ? { sizeBytes: bytes.byteLength } : {}),
            },
            readSucceeded: true,
        };
    }
    catch (error) {
        if (error instanceof OfficePreviewSizeError) {
            return oversizedPreviewOutcome(error, textPreviewMaxBytes === undefined ? 'office' : 'text');
        }
        return { value: { type: 'text', content: '' }, readSucceeded: false };
    }
}
function oversizedPreviewOutcome(error, kind = 'office') {
    return {
        value: {
            type: kind === 'text' ? 'text' : 'binary',
            content: '',
            error: kind === 'text' ? 'Text file exceeds the inline preview size limit' : error.message,
            code: kind === 'text' ? TEXT_PREVIEW_TOO_LARGE : error.code,
            sizeBytes: error.sizeBytes,
            maxBytes: error.maxBytes,
        },
        readSucceeded: false,
    };
}
async function remoteControlFileContentLimitResponse(headers, workspace, filePath, metrics, route) {
    if (headers.get(RC_REQUEST_SOURCE_HEADER) !== RC_REQUEST_SOURCE_VALUE)
        return undefined;
    const absolute = await resolveWorkspacePath(workspace, filePath);
    if (!absolute)
        return undefined;
    let info;
    try {
        info = await stat(absolute);
    }
    catch {
        return undefined;
    }
    if (!info.isFile())
        return undefined;
    return remoteControlFileSizeLimitResponse(headers, info.size, metrics, route);
}
function remoteControlFileSizeLimitResponse(headers, sizeBytes, metrics, route) {
    if (!headers || headers.get(RC_REQUEST_SOURCE_HEADER) !== RC_REQUEST_SOURCE_VALUE) {
        return undefined;
    }
    const maxBytes = readPositiveIntegerHeader(headers, RC_FILE_CONTENT_MAX_BYTES_HEADER) ??
        DEFAULT_RC_FILE_CONTENT_MAX_BYTES;
    if (sizeBytes <= maxBytes)
        return undefined;
    metrics?.incr('remote_control_file_content_rejected_total', {
        reason: 'too_large',
        route,
    });
    return json({
        error: 'File content is too large for remote-control inline response',
        code: 'REMOTE_CONTROL_FILE_CONTENT_TOO_LARGE',
        sizeBytes,
        maxBytes,
    }, { status: 413 });
}
function readPositiveIntegerHeader(headers, name) {
    const raw = headers.get(name);
    if (!raw)
        return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
        return undefined;
    return value;
}
async function readWorkspaceFileForDiffScope(workspace, filePath, scope) {
    if (scope !== 'staged')
        return readWorkspaceFile(workspace, filePath);
    const indexContent = await readWorkspaceTextFileFromGitIndex(workspace, filePath);
    return indexContent ?? { type: 'text', content: '' };
}
async function readWorkspaceTextFileFromGitIndex(workspace, filePath) {
    const ext = extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext) && !TEXT_EXTENSIONS.has(ext))
        return undefined;
    let normalizedPath;
    try {
        normalizedPath = normalizeGitActionPath(filePath);
    }
    catch {
        return undefined;
    }
    const result = await git(['show', `:${normalizedPath}`], workspace);
    if (result.code !== 0)
        return undefined;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(result.stdout)) {
        return undefined;
    }
    return { type: 'text', content: result.stdout };
}
export async function searchFiles(workspace, query, limit, includeDirectories = false) {
    const root = resolveWorkspace(workspace);
    const needle = query.trim().toLowerCase();
    if (!needle || limit <= 0)
        return [];
    const gitFiles = await listGitSearchCandidates(workspace);
    const files = gitFiles ?? (await listFsSearchCandidates(root, includeDirectories));
    // A trailing slash identifies directories without changing file-only callers.
    const candidates = new Set(files);
    if (includeDirectories) {
        if (gitFiles) {
            const directories = await git(['ls-files', '--others', '--directory', '--exclude-standard', '-z'], workspace);
            if (directories.code === 0) {
                for (const path of directories.stdout.split('\0')) {
                    if (path.endsWith('/'))
                        candidates.add(path);
                }
            }
        }
        addParentDirectories(candidates);
    }
    return [...candidates]
        .filter(isSearchableRelativePath)
        .map((filePath) => ({ filePath, score: scoreFileSearchCandidate(filePath, needle) }))
        .filter((item) => item.score !== undefined)
        .sort((a, b) => a.score - b.score || a.filePath.localeCompare(b.filePath))
        .slice(0, limit)
        .map((item) => toPortableRelativePath(item.filePath));
}
async function listGitSearchCandidates(workspace) {
    const [result, deletedResult] = await Promise.all([
        git(['ls-files', '-co', '--exclude-standard', '-z'], workspace),
        git(['ls-files', '-d', '-z'], workspace),
    ]);
    if (result.code !== 0 || deletedResult.code !== 0)
        return undefined;
    const deleted = new Set(deletedResult.stdout.split('\0').filter(Boolean));
    const seen = new Set();
    const candidates = [];
    for (const filePath of result.stdout.split('\0')) {
        if (!filePath ||
            deleted.has(filePath) ||
            seen.has(filePath) ||
            !isSearchableRelativePath(filePath)) {
            continue;
        }
        seen.add(filePath);
        candidates.push(filePath);
    }
    return candidates;
}
async function listFsSearchCandidates(root, includeDirectories = false) {
    const results = [];
    await walk(root, async (absolute, entry) => {
        if (entry.isDirectory()) {
            if (includeDirectories)
                results.push(`${toPortableRelativePath(relative(root, absolute))}/`);
            return true;
        }
        const rel = relative(root, absolute);
        if (isSearchableRelativePath(rel))
            results.push(rel);
        return true;
    });
    return results;
}
function isSearchableRelativePath(filePath) {
    return filePath
        .split(/[\\/]/u)
        .filter(Boolean)
        .every((segment) => !HIDDEN_SEARCH_DIRS.has(segment));
}
async function listDirs(directory, query, maxDepth, offset, limit, hideDotFiles) {
    const root = resolvePath(directory);
    const entries = [];
    const needle = query.toLowerCase();
    await walk(root, async (absolute, entry, depth) => {
        if (!entry.isDirectory())
            return false;
        if (depth > maxDepth)
            return false;
        const rel = relative(root, absolute);
        if (hideDotFiles && basename(absolute).startsWith('.'))
            return false;
        if (!query ||
            rel.toLowerCase().includes(needle) ||
            basename(absolute).toLowerCase().includes(needle)) {
            entries.push({ relative: rel ? `${rel}/` : absolute, absolute, type: 'dir' });
        }
        return true;
    });
    entries.sort((a, b) => a.relative.localeCompare(b.relative));
    return { entries: entries.slice(offset, offset + limit), total: entries.length };
}
async function walk(root, visit, depth = 0) {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (HIDDEN_SEARCH_DIRS.has(entry.name) || entry.isSymbolicLink())
            continue;
        const absolute = join(root, entry.name);
        const shouldDescend = await visit(absolute, entry, depth + 1);
        if (shouldDescend && entry.isDirectory()) {
            await walk(absolute, visit, depth + 1);
        }
    }
}
async function getGitChanges(workspace, mode, gitChangesCoordinator) {
    return mode === 'fast'
        ? (await gitChangesCoordinator.getChanges(workspace, 'fast')).changes
        : await gitChangesCoordinator.getChanges(workspace, 'full');
}
async function captureGitChangesBase(workspace) {
    const repo = await isGitRepo(workspace);
    if (!repo)
        return { changes: emptyChanges(false), untrackedPaths: new Set() };
    const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0;
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace);
    if (status.code !== 0) {
        return {
            changes: {
                ...emptyChanges(true),
                hasHead,
                error: status.stderr || status.stdout,
            },
            untrackedPaths: new Set(),
        };
    }
    const parsedStatus = parsePorcelainStatus(status.stdout);
    return {
        changes: {
            isGitRepo: true,
            changedFiles: parsedStatus.files.length,
            stagedFiles: parsedStatus.stagedFiles,
            unstagedFiles: parsedStatus.unstagedFiles,
            untrackedFiles: parsedStatus.untrackedFiles,
            insertions: 0,
            deletions: 0,
            hasHead,
            files: parsedStatus.files,
            lineStatsStatus: 'skipped',
        },
        untrackedPaths: parsedStatus.untrackedPaths,
    };
}
async function enrichGitChanges(workspace, base) {
    if (!base.changes.isGitRepo || base.changes.error)
        return base.changes;
    const files = base.changes.files.map((file) => ({ ...file }));
    const statsByScope = new Map();
    let lineStatsComplete = true;
    await Promise.all(gitDiffScopes('all').map(async (scope) => {
        const numstat = await git(gitNumstatArgs(scope, base.changes.hasHead), workspace);
        const parsedNumstat = parseNumstat(numstat.stdout);
        if (numstat.code !== 0 || !parsedNumstat.complete)
            lineStatsComplete = false;
        statsByScope.set(scope, parsedNumstat.stats);
    }));
    for (const file of files) {
        const fileStats = file.changeScope
            ? statsByScope.get(file.changeScope)?.get(file.path)
            : undefined;
        if (fileStats) {
            file.additions = fileStats.additions;
            file.deletions = fileStats.deletions;
        }
        else if (file.status === 'added' && base.untrackedPaths.has(file.path)) {
            const lines = await readWorkspaceTextLines(workspace, file.path);
            if (lines) {
                file.additions = lines.length;
            }
            else {
                lineStatsComplete = false;
            }
        }
    }
    return {
        ...base.changes,
        insertions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        files,
        lineStatsStatus: lineStatsComplete ? 'ready' : 'partial',
    };
}
export async function getGitMetadata(workspace) {
    if (!(await isGitRepo(workspace))) {
        return { isGitRepo: false, branch: '', isWorktree: false };
    }
    const branch = await git(['branch', '--show-current'], workspace);
    const gitDirectories = await git(['rev-parse', '--git-dir', '--git-common-dir'], workspace);
    const remotes = await git(['remote'], workspace);
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], workspace);
    const counts = upstream.code === 0
        ? await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], workspace)
        : undefined;
    const [aheadRaw, behindRaw] = counts?.stdout.trim().split(/\s+/, 2) ?? [];
    const [gitDir, gitCommonDir] = gitDirectories.stdout
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
    return {
        isGitRepo: true,
        branch: branch.stdout.trim(),
        isWorktree: gitDirectories.code === 0 &&
            gitDir !== undefined &&
            gitCommonDir !== undefined &&
            resolve(workspace, gitDir) !== resolve(workspace, gitCommonDir),
        ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
        behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
        hasUpstream: upstream.code === 0,
        hasRemote: remotes.stdout.trim().length > 0,
        canPush: remotes.stdout.trim().length > 0,
        hasHead: (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0,
    };
}
async function getGitBranches(workspace, includeRemote) {
    if (!(await isGitRepo(workspace)))
        return { success: false, current: '', branches: [], error: 'Not a git repository' };
    const current = (await git(['branch', '--show-current'], workspace)).stdout.trim();
    const local = (await git(['branch', '--format=%(refname:short)'], workspace)).stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const remote = includeRemote
        ? (await git(['branch', '-r', '--format=%(refname:short)'], workspace)).stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.endsWith('/HEAD'))
        : [];
    return { success: true, current, branches: local, local, ...(includeRemote ? { remote } : {}) };
}
async function getDefaultBranch(workspace) {
    const symbolic = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], workspace);
    if (symbolic.code === 0 && symbolic.stdout.trim()) {
        return {
            success: true,
            branch: symbolic.stdout.trim().replace(/^origin\//, ''),
            source: 'symbolic-ref',
        };
    }
    const branches = await getGitBranches(workspace, false);
    const local = Array.isArray(branches.local) ? branches.local : [];
    const branch = local.includes('main')
        ? 'main'
        : local.includes('master')
            ? 'master'
            : String(branches.current ?? '');
    return branch
        ? { success: true, branch, source: 'fallback-probe' }
        : { success: false, error: 'No default branch found' };
}
async function isGitRepo(workspace) {
    return (await git(['rev-parse', '--is-inside-work-tree'], workspace)).stdout.trim() === 'true';
}
async function gitMutation(body, args, gitChangesCoordinator) {
    const workspace = readString(body, 'workspace');
    if (!workspace)
        return { success: false, error: 'workspace is required' };
    if (args.some((arg) => !arg))
        return { success: false, error: 'missing git argument' };
    return toMutationResult(await withGitChangesInvalidation(workspace, gitChangesCoordinator, () => git(args, workspace)));
}
async function withGitChangesInvalidation(workspace, gitChangesCoordinator, operation) {
    // The first barrier detaches requests from the snapshot that existed before
    // the mutation. The second detaches any read that raced while Git was
    // mutating, so post-mutation callers are forced onto a fresh base.
    gitChangesCoordinator.invalidate(workspace);
    try {
        return await operation();
    }
    finally {
        gitChangesCoordinator.invalidate(workspace);
    }
}
async function readDiffContext(workspace, filePath, scope) {
    const contextContent = scope === 'staged'
        ? await readTextFromGitIndex(workspace, filePath)
        : await readTextForWorkspaceDiff(workspace, filePath);
    if (contextContent === undefined)
        return undefined;
    return {
        contextContent,
        ...(scope === 'staged' || scope === 'unstaged' ? { changeScope: scope } : {}),
    };
}
async function readTextFromGitIndex(workspace, filePath) {
    let normalizedPath;
    try {
        normalizedPath = normalizeGitActionPath(filePath);
    }
    catch {
        return undefined;
    }
    const result = await git(['show', `:${normalizedPath}`], workspace);
    if (result.code !== 0 || !isDiffContextTextContent(result.stdout))
        return undefined;
    return result.stdout;
}
async function readTextForWorkspaceDiff(workspace, filePath) {
    const content = await readWorkspaceFile(workspace, filePath);
    if (content.type !== 'text' || typeof content.content !== 'string')
        return undefined;
    return isDiffContextTextContent(content.content) ? content.content : undefined;
}
function readGitDiffScope(scope) {
    return scope === 'staged' || scope === 'unstaged' || scope === 'all' ? scope : 'all';
}
function isDiffContextTextContent(content) {
    return (content.length > 0 && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/u.test(content));
}
async function applyGitFileChangeAction(body, gitChangesCoordinator) {
    const workspace = readString(body, 'workspace');
    if (!workspace)
        return { success: false, error: 'workspace is required' };
    if (!(await isGitRepo(workspace)))
        return { success: false, error: 'Not a git repository' };
    const action = readGitFileChangeAction(body);
    if (!action)
        return { success: false, error: 'action is required' };
    const scope = readGitChangeScope(body);
    let paths;
    try {
        paths = normalizeGitActionPaths(resolvePath(workspace), resolveGitChangeActionPaths(body, scope));
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (paths.length === 0)
        return { success: false, error: 'No paths provided' };
    return await withGitChangesInvalidation(workspace, gitChangesCoordinator, async () => {
        if (action === 'stage') {
            return toMutationResult(await git(['add', '--', ...paths], workspace));
        }
        if (action === 'unstage') {
            return toMutationResult(await git(['restore', '--staged', '--', ...paths], workspace));
        }
        if (scope === 'staged') {
            return {
                success: false,
                error: 'Staged changes cannot be discarded directly. Unstage them first.',
            };
        }
        return discardGitPaths(workspace, paths);
    });
}
function readGitFileChangeAction(body) {
    const action = readString(body, 'action');
    return action === 'stage' || action === 'unstage' || action === 'discard' ? action : undefined;
}
function readGitChangeScope(body) {
    const scope = readString(body, 'scope');
    return scope === 'staged' || scope === 'unstaged' || scope === 'all' ? scope : 'all';
}
function resolveGitChangeActionPaths(body, scope) {
    const path = readString(body, 'path');
    const originalPath = readString(body, 'originalPath') ?? readString(body, 'original_path');
    if (path && originalPath && path !== originalPath) {
        if (scope === 'staged')
            return [originalPath];
        if (scope === 'unstaged')
            return [path];
        return [originalPath, path];
    }
    const paths = readStringArray(body, 'paths');
    return paths.length > 0
        ? paths
        : [path, originalPath].filter((item) => Boolean(item));
}
async function discardGitPaths(workspace, paths) {
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], workspace);
    if (status.code !== 0)
        return toMutationResult(status);
    const parsed = parsePorcelainStatus(status.stdout);
    const untrackedPaths = new Set(parsed.untrackedPaths);
    const trackedPaths = paths.filter((filePath) => !untrackedPaths.has(filePath));
    if (trackedPaths.length > 0) {
        const result = await git(['restore', '--worktree', '--', ...trackedPaths], workspace);
        if (result.code !== 0)
            return toMutationResult(result);
    }
    await Promise.all(Array.from(untrackedPaths, async (filePath) => {
        const absolutePath = resolvePath(join(workspace, ...filePath.split('/')));
        if (!isPathInside(resolvePath(workspace), absolutePath))
            return;
        await rm(absolutePath, { recursive: true, force: true });
    }));
    return { success: true };
}
function normalizeGitActionPath(filePath) {
    const trimmed = filePath.trim();
    if (!trimmed ||
        trimmed.includes('\0') ||
        isAbsolute(trimmed) ||
        /^[a-zA-Z]:[\\/]/u.test(trimmed)) {
        throw new Error(`Invalid git path: ${filePath}`);
    }
    const normalized = posix.normalize(trimmed.replace(/\\/gu, '/'));
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Invalid git path: ${filePath}`);
    }
    return normalized;
}
function normalizeGitActionPaths(workspaceRoot, paths) {
    const normalizedPaths = new Set();
    for (const filePath of paths) {
        const normalized = normalizeGitActionPath(filePath);
        const absolutePath = resolvePath(join(workspaceRoot, ...normalized.split('/')));
        if (!isPathInside(workspaceRoot, absolutePath)) {
            throw new Error(`Path is outside workspace: ${filePath}`);
        }
        normalizedPaths.add(normalized);
    }
    return Array.from(normalizedPaths);
}
async function validateGitBranchBody(body) {
    const workspace = readString(body, 'workspace');
    if (!workspace)
        return json({ success: false, error: 'workspace is required' }, { status: 400 });
    const branch = readString(body, 'branch');
    return branch
        ? validateGitBranch(workspace, branch)
        : json({ success: false, error: 'branch is required' }, { status: 400 });
}
async function validateGitBranch(workspace, branch) {
    if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
        return json({ success: false, error: `Invalid git branch name: ${branch}` }, { status: 400 });
    }
    const check = await git(['check-ref-format', `refs/heads/${branch}`], workspace);
    return check.code === 0
        ? undefined
        : json({ success: false, error: `Invalid git branch name: ${check.stderr || check.stdout}` }, { status: 400 });
}
async function git(args, workspace) {
    return await gitCommandRunner(args, workspace);
}
function gitDiffScopes(scope) {
    return scope === 'staged' || scope === 'unstaged' ? [scope] : ['staged', 'unstaged'];
}
function gitDiffArgs(scope, hasHead, paths = []) {
    const args = ['diff', '--no-ext-diff', '--unified=3'];
    if (scope === 'staged') {
        args.push('--cached');
        if (hasHead)
            args.push('HEAD');
    }
    else if (scope === 'all') {
        if (hasHead) {
            args.push('HEAD');
        }
        else {
            args.push('--cached');
        }
    }
    args.push('--', ...paths);
    return args;
}
function gitNumstatArgs(scope, hasHead) {
    const args = ['diff', '--numstat', '-z'];
    if (scope === 'staged') {
        args.push('--cached');
        if (hasHead)
            args.push('HEAD');
    }
    args.push('--');
    return args;
}
function parsePorcelainStatus(stdout) {
    const records = stdout.split('\0');
    const files = [];
    const untrackedPaths = new Set();
    let stagedFiles = 0;
    let unstagedFiles = 0;
    let untrackedFiles = 0;
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record)
            continue;
        const x = record[0] ?? ' ';
        const y = record[1] ?? ' ';
        const path = record.slice(3);
        if (!path)
            continue;
        let originalPath;
        if ((x === 'R' || x === 'C') && records[index + 1]) {
            index += 1;
            originalPath = records[index];
        }
        if (x === '?' && y === '?') {
            untrackedFiles += 1;
            untrackedPaths.add(path);
            files.push({
                path,
                status: 'added',
                additions: 0,
                deletions: 0,
                changeScope: 'unstaged',
            });
            unstagedFiles += 1;
            continue;
        }
        else {
            if (x !== ' ')
                stagedFiles += 1;
            if (y !== ' ')
                unstagedFiles += 1;
        }
        if (x !== ' ') {
            files.push({
                path,
                ...(originalPath ? { originalPath } : {}),
                status: statusFromGitCode(x),
                additions: 0,
                deletions: 0,
                changeScope: 'staged',
            });
        }
        if (y !== ' ') {
            files.push({
                path,
                status: statusFromGitCode(y),
                additions: 0,
                deletions: 0,
                changeScope: 'unstaged',
            });
        }
    }
    return { files, stagedFiles, unstagedFiles, untrackedFiles, untrackedPaths };
}
function statusFromGitCode(code) {
    if (code === 'A' || code === '?')
        return 'added';
    if (code === 'D')
        return 'deleted';
    return 'modified';
}
function parseNumstat(stdout) {
    const stats = new Map();
    let complete = true;
    const records = stdout.split('\0');
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record?.trim())
            continue;
        const [addRaw, delRaw, ...pathParts] = record.split('\t');
        let filePath = pathParts.join('\t');
        if (!filePath && records[index + 2]) {
            index += 2;
            filePath = records[index] ?? '';
        }
        if (!filePath)
            continue;
        const additions = Number.parseInt(addRaw ?? '', 10);
        const deletions = Number.parseInt(delRaw ?? '', 10);
        if (!Number.isFinite(additions) || !Number.isFinite(deletions))
            complete = false;
        stats.set(filePath, {
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
        });
    }
    return { stats, complete };
}
function splitDiffBlocksByFile(diff) {
    const blocks = new Map();
    for (const block of diff.split(/(?=^diff --git )/mu)) {
        if (!block.trim())
            continue;
        const match = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/mu.exec(block);
        const filePath = match?.[2] ?? match?.[1];
        if (filePath)
            blocks.set(unquoteGitPath(filePath), block.trimEnd());
    }
    return blocks;
}
function isBinaryDiff(diff) {
    return /^Binary files /mu.test(diff) || /\nGIT binary patch\n/u.test(diff);
}
async function buildAddedFileDiff(workspace, filePath) {
    if (!(await isUntrackedWorkspacePath(workspace, filePath)))
        return undefined;
    const lines = await readWorkspaceTextLines(workspace, filePath);
    if (!lines)
        return undefined;
    if (lines.length === 0)
        return undefined;
    return {
        additions: lines.length,
        diff: [
            `diff --git a/${filePath} b/${filePath}`,
            'new file mode 100644',
            '--- /dev/null',
            `+++ b/${filePath}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
        ].join('\n'),
    };
}
async function isUntrackedBinaryFile(workspace, filePath) {
    if (!(await isUntrackedWorkspacePath(workspace, filePath)))
        return false;
    const content = await readWorkspaceFile(workspace, filePath);
    return content.type === 'binary';
}
async function isUntrackedWorkspacePath(workspace, filePath) {
    const untracked = await git(['ls-files', '--others', '-z', '--exclude-standard', '--', filePath], workspace);
    return untracked.stdout
        .split('\0')
        .filter(Boolean)
        .some((line) => line === filePath);
}
async function readWorkspaceTextLines(workspace, filePath) {
    const outcome = await readWorkspaceFileOutcome(workspace, filePath);
    if (!outcome.readSucceeded)
        return undefined;
    const content = outcome.value;
    if (content.type !== 'text' || typeof content.content !== 'string')
        return undefined;
    const lines = content.content.split('\n');
    if (lines[lines.length - 1] === '')
        lines.pop();
    return lines;
}
function emptyChanges(repoAvailable) {
    return {
        isGitRepo: repoAvailable,
        changedFiles: 0,
        stagedFiles: 0,
        unstagedFiles: 0,
        untrackedFiles: 0,
        insertions: 0,
        deletions: 0,
        hasHead: false,
        files: [],
        lineStatsStatus: 'skipped',
    };
}
function toMutationResult(result) {
    return result.code === 0
        ? { success: true, output: result.stdout || result.stderr }
        : { success: false, error: result.stderr || result.stdout };
}
async function runOpenCommand(action, target) {
    const command = resolveOpenCommand(action, target, openCommandRuntime);
    if (!command) {
        return json({ error: `Opening files is not supported on ${openCommandRuntime.platform}` }, { status: 501 });
    }
    try {
        await openCommandRuntime.run(command.file, command.args, {
            windowsHide: !command.windowsShow,
            windowsVerbatimArguments: command.windowsVerbatimArguments,
        });
        return json({ ok: true });
    }
    catch (error) {
        const code = getOpenCommandErrorCode(error);
        // explorer.exe can report a numeric non-zero exit code after Windows has
        // already accepted the open request. Preserve that compatibility, but do
        // not hide spawn failures such as ENOENT, EACCES, or EPERM.
        if (openCommandRuntime.platform === 'win32' && typeof code === 'number') {
            return json({ ok: true });
        }
        logger.warn({
            action,
            platform: openCommandRuntime.platform,
            executable: basename(command.file),
            targetKind: extname(target) ? 'file' : 'directory',
            errorCode: code ?? 'UNKNOWN',
        }, 'Local file open command failed');
        return json({ error: 'Unable to open the local file', code: 'OPEN_COMMAND_FAILED' }, { status: 422 });
    }
}
function getOpenCommandErrorCode(error) {
    if (!error || typeof error !== 'object' || !('code' in error))
        return undefined;
    const code = error.code;
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}
function resolveOpenCommand(action, target, runtime = openCommandRuntime) {
    if (runtime.platform === 'darwin') {
        return { file: 'open', args: action === 'reveal' ? ['-R', target] : [target] };
    }
    if (runtime.platform === 'win32') {
        const windowsDirectory = runtime.env.WINDIR || runtime.env.SystemRoot;
        const explorer = windowsDirectory
            ? win32.join(windowsDirectory, 'explorer.exe')
            : 'explorer.exe';
        return action === 'reveal'
            ? {
                file: explorer,
                args: [`/select,"${target}"`],
                windowsShow: true,
                windowsVerbatimArguments: true,
            }
            : {
                file: explorer,
                args: [`"${target}"`],
                windowsShow: true,
                windowsVerbatimArguments: true,
            };
    }
    if (runtime.platform === 'linux') {
        return { file: 'xdg-open', args: [action === 'reveal' ? dirname(target) : target] };
    }
    return undefined;
}
async function resolveBodyPath(body) {
    const workspace = readString(body, 'workspace');
    const filePath = readString(body, 'path');
    if (!workspace)
        return json({ error: 'workspace is required' }, { status: 400 });
    if (!filePath)
        return json({ error: 'path is required' }, { status: 400 });
    const resolved = await resolveExistingWorkspacePath(workspace, filePath);
    return resolved.ok
        ? { absolute: resolved.absolute }
        : json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
}
async function resolveWorkspacePath(workspace, child) {
    const root = resolveWorkspace(workspace);
    const target = resolveInside(root, child);
    if (!target)
        return undefined;
    try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        return isPathInside(realRoot, realTarget) ? realTarget : undefined;
    }
    catch {
        return undefined;
    }
}
async function resolveExistingWorkspacePath(workspace, child) {
    const root = resolveWorkspace(workspace);
    const target = resolveInside(root, child);
    if (!target) {
        return {
            ok: false,
            status: 400,
            error: 'Path traversal denied',
            code: 'PATH_TRAVERSAL',
        };
    }
    let realRoot;
    try {
        realRoot = await realpath(root);
    }
    catch (error) {
        return { ok: false, ...classifyExistingPathError(error, 'workspace') };
    }
    let realTarget;
    try {
        realTarget = await realpath(target);
    }
    catch (error) {
        return { ok: false, ...classifyExistingPathError(error, 'file') };
    }
    if (!isPathInside(realRoot, realTarget)) {
        return {
            ok: false,
            status: 400,
            error: 'Path traversal denied',
            code: 'PATH_TRAVERSAL',
        };
    }
    return { ok: true, absolute: realTarget };
}
function resolveWorkspace(workspace) {
    return resolvePath(workspace);
}
function resolveInside(root, child) {
    const target = isAbsolute(child) ? resolve(child) : resolve(root, child);
    return isPathInside(root, target) ? target : undefined;
}
function isPathInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
async function resolveWorktreeTarget(workspaceRoot, dirName) {
    if (isAbsolute(dirName))
        return undefined;
    if (dirName !== basename(dirName) || dirName.includes('\\'))
        return undefined;
    const worktreeParent = join(workspaceRoot, '.worktrees');
    const lexicalTarget = resolveInside(worktreeParent, dirName);
    if (!lexicalTarget)
        return undefined;
    try {
        await mkdir(worktreeParent, { recursive: true });
        const [realRoot, realParent] = await Promise.all([
            realpath(workspaceRoot),
            realpath(worktreeParent),
        ]);
        if (!isPathInside(realRoot, realParent))
            return undefined;
        const target = resolve(realParent, dirName);
        return isPathInside(realParent, target) ? target : undefined;
    }
    catch {
        return undefined;
    }
}
function isProbablyBinary(bytes) {
    if (bytes.length === 0)
        return false;
    if (bytes.includes(0))
        return true;
    try {
        FATAL_UTF8_DECODER.decode(bytes);
    }
    catch {
        return true;
    }
    const sampleLength = Math.min(bytes.length, 8_000);
    let controlBytes = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const byte = bytes[index];
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)
            controlBytes += 1;
    }
    return controlBytes / sampleLength > 0.3;
}
/**
 * Decodes a byte-order-marked UTF-16 payload into text.
 *
 * Windows-authored text formats (`.inf`, `.reg`, PowerShell output) are
 * routinely UTF-16LE, where every ASCII character carries a NUL padding byte.
 * `isProbablyBinary` rejects any buffer containing NUL, so without this decode
 * such files are reported as binary and never reach the code viewer.
 *
 * Only reached for extensions that are not already known binaries: those return
 * earlier, so a `.bin` that happens to start with `FF FE` stays binary.
 */
function decodeUtf16TextBytes(bytes) {
    if (bytes.length < 4 || bytes.length % 2 !== 0)
        return undefined;
    let text;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        text = bytes.subarray(2).toString('utf16le');
    }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        const swapped = Buffer.from(bytes.subarray(2));
        swapped.swap16();
        text = swapped.toString('utf16le');
    }
    else {
        return undefined;
    }
    return isProbablyBinaryText(text) ? undefined : text;
}
/** Control-character heuristic for already-decoded text, mirroring `isProbablyBinary`. */
function isProbablyBinaryText(text) {
    if (text.length === 0)
        return false;
    if (text.includes('\u0000'))
        return true;
    const sampleLength = Math.min(text.length, 8_000);
    let controlChars = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)
            controlChars += 1;
    }
    return controlChars / sampleLength > 0.3;
}
function requiredQuery(url, key) {
    const value = url.searchParams.get(key);
    return value || json({ error: `${key} is required` }, { status: 400 });
}
async function readJsonBody(request) {
    try {
        const data = (await request.json());
        return data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : {};
    }
    catch {
        return {};
    }
}
function readString(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function readStringArray(data, key) {
    const value = data[key];
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.length > 0);
}
function readRecord(data, key) {
    const value = data[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function clampInt(value, fallback, min, max) {
    const parsed = Number.parseInt(value ?? '', 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(min, Math.min(max, parsed));
}
function unquoteGitPath(value) {
    return value.replace(/^"|"$/g, '');
}
function json(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
    });
}
function notFound(pathname) {
    return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}
//# sourceMappingURL=api.js.map