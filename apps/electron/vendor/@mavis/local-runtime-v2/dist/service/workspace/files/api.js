import { realpath, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { getWorkspaceImagePreviewMimeType } from '@mavis/shared/media-asset-meta';
import { OFFICE_PREVIEW_TOO_LARGE } from '@mavis/shared/office-preview-limits';
import { TEXT_PREVIEW_MAX_BYTES, TEXT_PREVIEW_TOO_LARGE } from '@mavis/shared/text-preview-limits';
import { IdeLauncher, IdeLauncherError } from '../ide/launcher.js';
import { routeFileSave } from './save.js';
import { classifyExistingPathError } from './path-error.js';
import { buildWorkspaceFileThumbnail, normalizeThumbnailMaxEdge, resetWorkspaceFileThumbnailCache, } from './preview/thumbnail.js';
import { WorkspaceGitChangesCoordinator } from '../git/workspace-git-changes-coordinator.js';
import { defaultGitChangesCoordinator, git, readWorkspaceFileForDiffScope, getGitChanges, routeGitApi, } from '../git/git-api.js';
import { routeFsApi, listFileTree, searchFiles } from './file-search.js';
import { requiredQuery, json, gitDiffScopes, readJsonBody, readString, notFound, normalizeGitActionPath, resolveWorkspace, resolveInside, isPathInside, } from './file-api-shared.js';
import { remoteControlFileContentLimitResponse, readWorkspaceFile, readWorkspaceFileOutcome, streamWorkspaceMedia, serveFilePreview, readWorkspaceTextLines, } from './file-content.js';
import { runOpenCommand } from './open-command.js';
const VIDEO_PREVIEW_MIME_TYPES = new Map([
    ['.m4v', 'video/x-m4v'],
    ['.mkv', 'video/x-matroska'],
    ['.mov', 'video/quicktime'],
    ['.mp4', 'video/mp4'],
    ['.ogv', 'video/ogg'],
    ['.webm', 'video/webm'],
]);
let ideLauncher = new IdeLauncher();
/** @internal Exported only for focused tests. */
export function __setLocalFileApiIdeLauncherForTests(nextLauncher) {
    ideLauncher = nextLauncher ?? new IdeLauncher();
}
/** @internal Exported only for focused tests. */
export function __resetFileThumbnailCacheForTests() {
    resetWorkspaceFileThumbnailCache();
}
export async function routeLocalFileApi(request, parts, url, options = {}) {
    if (parts[0] === 'file') {
        return routeFileApi(request, parts.slice(1).join('/'), url, options);
    }
    if (parts[0] === 'fs') {
        return routeFsApi(request.method.toUpperCase(), parts.slice(1).join('/'), url);
    }
    return undefined;
}
async function routeFileApi(request, tail, url, { metrics, gitChangesCoordinator = defaultGitChangesCoordinator }) {
    if (tail.startsWith('git/')) {
        return routeGitApi(request, tail.slice('git/'.length), url, gitChangesCoordinator);
    }
    const routes = new Map([
        ['GET tree', () => routeFileTree(url)],
        ['GET info', () => routeFileInfo(url)],
        ['GET content', () => routeFileContent(request, url, metrics)],
        ['GET thumbnail', () => routeFileThumbnail(url)],
        ['GET media', () => routeFileMedia(request, url)],
        ['GET preview', () => serveFilePreview(url, request.headers, metrics)],
        ['GET diff', () => routeFileDiff(url)],
        ['GET diff-context', () => routeFileDiffContext(url)],
        ['GET diffs', () => routeFileDiffs(url, gitChangesCoordinator)],
        ['GET status', () => routeFileStatus(url, gitChangesCoordinator)],
        ['GET search', () => routeFileSearch(url)],
        ['GET open-app', () => json(null)],
        ['GET ide-apps', async () => json(await ideLauncher.listIdeApps())],
        ['POST open', () => routeFileOpen(request, 'open')],
        ['POST reveal', () => routeFileOpen(request, 'reveal')],
        ['POST open-in-ide', () => routeFileOpenInIde(request)],
        [
            'POST save',
            () => routeFileSave(request, { readJsonBody, resolveBodyPath, readString, json }),
        ],
        ['POST commit-message', () => routeFileCommitMessage(request, gitChangesCoordinator)],
    ]);
    const handler = routes.get(`${request.method.toUpperCase()} ${tail}`);
    return handler ? handler() : notFound(`/file/${tail}`);
}
async function routeFileTree(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    const subPath = url.searchParams.get('path') ?? '.';
    return json(await listFileTree(workspace, subPath));
}
async function routeFileInfo(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response)
        return filePath;
    const resolved = await resolveExistingWorkspacePath(workspace, filePath);
    if (!resolved.ok) {
        if (resolved.code === 'NOT_FOUND')
            return json({ exists: false, reason: 'file_not_found' });
        if (resolved.code === 'WORKSPACE_NOT_FOUND') {
            return json({ exists: false, reason: 'workspace_not_found' });
        }
        return json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    }
    const targetStat = await stat(resolved.absolute);
    let type = 'other';
    if (targetStat.isFile())
        type = 'file';
    else if (targetStat.isDirectory())
        type = 'directory';
    return json({ exists: true, type, sizeBytes: targetStat.size, modifiedAtMs: targetStat.mtimeMs });
}
async function routeFileContent(request, url, metrics) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    const filePath = requiredQuery(url, 'path');
    if (filePath instanceof Response)
        return filePath;
    const fileTooLarge = await remoteControlFileContentLimitResponse(request.headers, workspace, filePath, { metrics, route: 'content' });
    if (fileTooLarge)
        return fileTooLarge;
    const { value: content } = await readWorkspaceFileOutcome(workspace, filePath, TEXT_PREVIEW_MAX_BYTES);
    return json(content, content.code === OFFICE_PREVIEW_TOO_LARGE || content.code === TEXT_PREVIEW_TOO_LARGE
        ? { status: 413 }
        : undefined);
}
async function routeFileThumbnail(url) {
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
async function routeFileMedia(request, url) {
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
async function readDiffFallback(workspace, filePath, scope, diff) {
    if (diff.trim())
        return { binary: isBinaryDiff(diff), addedDiff: undefined };
    if (scope === 'staged')
        return { binary: false, addedDiff: undefined };
    const addedDiff = await buildAddedFileDiff(workspace, filePath);
    const binary = await isUntrackedBinaryFile(workspace, filePath);
    return { addedDiff, binary };
}
function diffPreview(binary, diff, empty) {
    if (binary)
        return { previewState: 'binary' };
    if (diff)
        return { diff, previewState: 'ready' };
    return empty;
}
async function routeFileDiff(url) {
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
    const { addedDiff, binary } = await readDiffFallback(workspace, filePath, scope, diff.stdout);
    const diffText = diff.code === 0 && diff.stdout.trim() ? diff.stdout : addedDiff?.diff;
    return json({
        ...content,
        ...(scope !== 'all' ? { changeScope: scope } : {}),
        ...diffPreview(binary, diffText, {}),
    });
}
async function routeFileDiffContext(url) {
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
async function routeFileDiffs(url, gitChangesCoordinator) {
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
        const { addedDiff, binary } = await readDiffFallback(workspace, file.path, fileScope, block ?? '');
        return {
            file: file.path,
            ...(file.originalPath ? { originalPath: file.originalPath } : {}),
            additions: file.additions || addedDiff?.additions || 0,
            deletions: file.deletions,
            status: file.status,
            changeScope: fileScope,
            ...diffPreview(binary, block ?? addedDiff?.diff, { previewState: 'no_diff' }),
        };
    })));
}
async function routeFileStatus(url, gitChangesCoordinator) {
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
async function routeFileSearch(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    const query = requiredQuery(url, 'query');
    if (query instanceof Response)
        return query;
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    return json(await searchFiles(workspace, query, Number.isFinite(limit) ? limit : 50, url.searchParams.get('includeDirectories') === 'true'));
}
async function routeFileOpen(request, action) {
    const body = await readJsonBody(request);
    const target = await resolveBodyPath(body);
    if (target instanceof Response)
        return target;
    return runOpenCommand(action, target.absolute);
}
async function routeFileOpenInIde(request) {
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
async function routeFileCommitMessage(request, gitChangesCoordinator) {
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
    let action = 'update';
    if (first?.status === 'added')
        action = 'add';
    else if (first?.status === 'deleted')
        action = 'remove';
    return json({ message: `chore: ${action} ${first ? basename(first.path) : 'workspace files'}` });
}
function ideLauncherErrorResponse(error) {
    if (error instanceof IdeLauncherError) {
        return json({ error: error.message, code: error.code }, { status: error.status });
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
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
function unquoteGitPath(value) {
    return value.replace(/^"|"$/g, '');
}
export { listFileTree, searchFiles } from './file-search.js';
export { createLocalWorkspaceGitFacade, createLocalFileApiGitChangesCoordinator, } from '../git/git-api.js';
//# sourceMappingURL=api.js.map