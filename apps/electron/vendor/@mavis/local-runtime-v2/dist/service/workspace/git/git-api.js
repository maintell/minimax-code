import { mkdir, realpath, rm } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { getDataDir } from '@mavis/config';
import { LocalReviewLinkStore } from '../../../infra/legacy-db/review-link.js';
import { generateDefaultWorktreeBranch } from '../worktree-branch.js';
import { git as runGitProcess, gitRoot } from '../operations/git-process.js';
import { resolvePath } from '../files/path-utils.js';
import { listWorkspaceGitWorktrees } from '../operations/worktrees.js';
import { WorkspaceGitChangesCoordinator, } from './workspace-git-changes-coordinator.js';
import { requiredQuery, json, readJsonBody, readString, notFound, BINARY_EXTENSIONS, TEXT_EXTENSIONS, normalizeGitActionPath, gitDiffScopes, isPathInside, resolveInside, } from '../files/file-api-shared.js';
import { readWorkspaceFile, readWorkspaceTextLines } from '../files/file-content.js';
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
let gitCommandRunner = runGitProcess;
export function createLocalFileApiGitChangesCoordinator() {
    return new WorkspaceGitChangesCoordinator(captureGitChangesBase, enrichGitChanges);
}
export const defaultGitChangesCoordinator = createLocalFileApiGitChangesCoordinator();
/** @internal Exported only for focused tests. */
export function __setLocalFileApiGitCommandRunnerForTests(nextRunner) {
    gitCommandRunner = nextRunner ?? runGitProcess;
    defaultGitChangesCoordinator.clear();
}
export async function routeGitApi(request, tail, url, gitChangesCoordinator) {
    const routes = new Map([
        ['GET probe', () => routeGitProbe(url)],
        ['GET changes', () => routeGitChanges(url, gitChangesCoordinator)],
        ['GET metadata', () => routeGitMetadata(url)],
        ['GET branches', () => routeGitBranches(url)],
        ['GET branch-picker', () => routeGitBranchPicker(url)],
        ['GET default-branch', () => routeGitDefaultBranch(url)],
        ['POST checkout', () => routeGitCheckout(request, gitChangesCoordinator, false)],
        ['POST create-branch', () => routeGitCheckout(request, gitChangesCoordinator, true)],
        ['POST commit', () => routeGitCommit(request, gitChangesCoordinator)],
        ['POST push', () => routeGitPush(request)],
        [
            'POST change-action',
            async () => json(await applyGitFileChangeAction(await readJsonBody(request), gitChangesCoordinator)),
        ],
        ['GET worktrees', () => routeGitWorktrees(url)],
        ['POST worktrees', () => routeGitCreateWorktree(request)],
        ['POST worktrees/remove', () => routeGitRemoveWorktree(request)],
    ]);
    const handler = routes.get(`${request.method.toUpperCase()} ${tail}`);
    return handler ? handler() : notFound(`/file/git/${tail}`);
}
async function routeGitProbe(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    return json({ isGitRepo: await isGitRepo(workspace) });
}
async function routeGitChanges(url, coordinator) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    const mode = url.searchParams.get('mode') === 'fast' ? 'fast' : 'full';
    return json(await getGitChanges(workspace, mode, coordinator));
}
async function routeGitMetadata(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    return json(await getGitMetadata(workspace));
}
async function routeGitBranches(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    const includeRemote = url.searchParams.get('includeRemote') === 'true';
    return json(await getGitBranches(workspace, includeRemote));
}
async function routeGitBranchPicker(url) {
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
async function routeGitDefaultBranch(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    return json(await getDefaultBranch(workspace));
}
async function routeGitCheckout(request, coordinator, create) {
    const body = await readJsonBody(request);
    const invalid = await validateGitBranchBody(body);
    if (invalid)
        return invalid;
    return json(await gitMutation(body, ['checkout', ...(create ? ['-b'] : []), readString(body, 'branch')], coordinator));
}
async function routeGitCommit(request, coordinator) {
    const body = await readJsonBody(request);
    const message = readString(body, 'message');
    if (!message)
        return json({ success: false, error: 'message is required' }, { status: 400 });
    const workspace = readString(body, 'workspace');
    if (!workspace)
        return json({ success: false, error: 'workspace is required' }, { status: 400 });
    const result = await withGitChangesInvalidation(workspace, coordinator, async () => {
        if (body.includeUnstaged !== false)
            await git(['add', '--all'], workspace);
        return await git(['commit', '-m', message], workspace);
    });
    return json(toMutationResult(result));
}
async function routeGitPush(request) {
    const body = await readJsonBody(request);
    const workspace = readString(body, 'workspace');
    if (!workspace)
        return json({ success: false, error: 'workspace is required' }, { status: 400 });
    const result = await git(['push'], workspace);
    if (result.code !== 0 && /no upstream branch|set-upstream|--set-upstream/i.test(result.stderr)) {
        return json(toMutationResult(await git(['push', '-u', 'origin', 'HEAD'], workspace)));
    }
    return json(toMutationResult(result));
}
async function routeGitWorktrees(url) {
    const workspace = requiredQuery(url, 'workspace');
    if (workspace instanceof Response)
        return workspace;
    return json(await listWorkspaceGitWorktrees(workspace));
}
async function routeGitCreateWorktree(request) {
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
    if (!worktreeDir)
        return json({ success: false, error: 'Invalid worktree dirName' }, { status: 400 });
    return createGitWorktree(workspaceRoot, { branch, worktreeDir, base });
}
async function createGitWorktree(workspaceRoot, { branch, worktreeDir, base }) {
    const result = await git(['worktree', 'add', '-b', branch, worktreeDir, base], workspaceRoot);
    return json(result.code === 0
        ? { success: true, worktreeDir, branch, resolvedBase: base }
        : { success: false, error: result.stderr || result.stdout });
}
async function routeGitRemoveWorktree(request) {
    const body = await readJsonBody(request);
    const workspace = readString(body, 'workspace');
    const worktreeDir = readString(body, 'worktreeDir');
    if (!workspace)
        return json({ success: false, error: 'workspace is required' }, { status: 400 });
    if (!worktreeDir)
        return json({ success: false, error: 'worktreeDir is required' }, { status: 400 });
    return json(toMutationResult(await git(['worktree', 'remove', worktreeDir], workspace)));
}
export async function readWorkspaceFileForDiffScope(workspace, filePath, scope) {
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
export async function getGitChanges(workspace, mode, gitChangesCoordinator) {
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
async function getGitMetadata(workspace) {
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
    return {
        isGitRepo: true,
        branch: branch.stdout.trim(),
        isWorktree: isLinkedWorktree(workspace, gitDirectories),
        ahead: Number.parseInt(aheadRaw ?? '0', 10) || 0,
        behind: Number.parseInt(behindRaw ?? '0', 10) || 0,
        hasUpstream: upstream.code === 0,
        hasRemote: remotes.stdout.trim().length > 0,
        canPush: remotes.stdout.trim().length > 0,
        hasHead: (await git(['rev-parse', '--verify', 'HEAD'], workspace)).code === 0,
    };
}
function isLinkedWorktree(workspace, directories) {
    const [gitDir, gitCommonDir] = directories.stdout
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
    return (directories.code === 0 &&
        gitDir !== undefined &&
        gitCommonDir !== undefined &&
        resolve(workspace, gitDir) !== resolve(workspace, gitCommonDir));
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
    const branch = ['main', 'master'].find((candidate) => local.includes(candidate)) ??
        String(branches.current ?? '');
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
export async function git(args, workspace) {
    return await gitCommandRunner(args, workspace);
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
function* readPorcelainRecords(stdout) {
    const records = stdout.split('\0');
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
        yield { x, y, path, originalPath };
    }
}
function parsePorcelainStatus(stdout) {
    const files = [];
    const untrackedPaths = new Set();
    let stagedFiles = 0;
    let unstagedFiles = 0;
    let untrackedFiles = 0;
    for (const { x, y, path, originalPath } of readPorcelainRecords(stdout)) {
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
        const counts = parseNumstatCounts(addRaw, delRaw);
        if (!counts.complete)
            complete = false;
        stats.set(filePath, counts.stats);
    }
    return { stats, complete };
}
function parseNumstatCounts(addRaw, delRaw) {
    const additions = Number.parseInt(addRaw ?? '', 10);
    const deletions = Number.parseInt(delRaw ?? '', 10);
    return {
        complete: Number.isFinite(additions) && Number.isFinite(deletions),
        stats: {
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
        },
    };
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
//# sourceMappingURL=git-api.js.map