import { mkdir, realpath, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { git } from './git-process.js';
export async function listWorkspaceGitWorktrees(workspace, options = {}) {
    const workspaceInfo = await readStat(workspace);
    if (!workspaceInfo?.isDirectory()) {
        return { success: false, worktrees: [], error: 'Workspace directory is unavailable' };
    }
    const rootResult = await git(['rev-parse', '--show-toplevel'], workspace);
    if (rootResult.code !== 0) {
        return {
            success: false,
            worktrees: [],
            error: rootResult.stderr || rootResult.stdout || 'Failed to inspect Git workspace',
        };
    }
    const root = rootResult.stdout.trim();
    const result = await git(['worktree', 'list', '--porcelain'], root);
    if (result.code !== 0) {
        return {
            success: false,
            worktrees: [],
            error: result.stderr || result.stdout || 'Failed to inspect Git worktrees',
        };
    }
    const entries = parseWorktreeEntries(result.stdout);
    const mainWorktreePath = options.usePrimaryWorktree ? entries[0]?.worktree : root;
    const activeWorktreePath = await canonicalPath(workspace);
    const managedParent = await resolveManagedParent(mainWorktreePath);
    const worktrees = await Promise.all(entries.map((entry) => toWorktreeInfo(entry, { mainWorktreePath, activeWorktreePath, managedParent })));
    return {
        success: true,
        current: String(mainWorktreePath ?? root),
        worktrees: worktrees.filter((entry) => entry !== null),
    };
}
export async function createWorkspaceGitWorktree(workspace, options = {}) {
    const rootResult = await readGitRoot(workspace);
    if (!rootResult.root)
        return { success: false, status: 400, error: rootResult.error };
    const plan = await prepareWorktreeCreatePlan(rootResult.root, options);
    if (!plan.plan)
        return { success: false, status: 400, error: plan.error };
    const result = await git(['worktree', 'add', '-b', plan.plan.branch, plan.plan.target, plan.plan.base], rootResult.root);
    return createWorktreeResult(result, plan.plan);
}
export async function removeWorkspaceGitWorktree(workspace, worktreeDir) {
    const rootResult = await git(['rev-parse', '--show-toplevel'], workspace);
    if (rootResult.code !== 0) {
        return { status: 400, success: false, reason: 'not_found', error: 'Not a git repository' };
    }
    const root = rootResult.stdout.trim();
    const target = await canonicalPath(worktreeDir);
    const listed = await listWorkspaceGitWorktrees(root, { usePrimaryWorktree: true });
    const entry = listed.worktrees?.find((item) => item.path && resolve(item.path) === resolve(target));
    if (!entry)
        return { status: 404, success: false, reason: 'not_found', error: 'Worktree was not found' };
    if (entry.isMain)
        return {
            status: 400,
            success: false,
            reason: 'main_worktree',
            error: 'The main worktree cannot be removed',
        };
    const result = await git(['worktree', 'remove', '--', target], root);
    return result.code === 0
        ? { status: 200, success: true }
        : {
            status: 500,
            success: false,
            reason: 'unknown',
            error: result.stderr || result.stdout || 'Failed to remove worktree',
        };
}
export async function removeManagedWorkspaceGitWorktree(workspace, worktreeDir, activeWorktreeDir, runningWorktreeDirs = []) {
    const listed = await listWorkspaceGitWorktrees(workspace, { usePrimaryWorktree: true });
    if (!listed.success)
        return { status: 400, success: false, reason: 'not_found', error: listed.error };
    const target = await canonicalPath(worktreeDir);
    const entry = findWorktree(listed.worktrees, target);
    const guard = validateManagedRemoval(entry, target, activeWorktreeDir ?? workspace, runningWorktreeDirs);
    if (guard)
        return guard;
    const changes = await git(['status', '--porcelain'], target);
    if (changes.code !== 0 || changes.stdout.trim()) {
        return {
            status: 409,
            success: false,
            reason: 'dirty_worktree',
            error: 'Commit, stash, or discard its changes before removing this worktree',
        };
    }
    return removeWorktreeResult(await git(['worktree', 'remove', '--', target], listed.current ?? workspace));
}
export async function removeManagedWorkspaceGitWorktreesBatch(items, activeWorktreeDir, runningWorktreeDirs = []) {
    const removedPaths = [];
    const failedItems = [];
    for (const item of items) {
        const result = await removeManagedWorkspaceGitWorktree(item.workspace, item.worktreeDir, activeWorktreeDir ?? item.workspace, runningWorktreeDirs);
        if (result.success)
            removedPaths.push(item.worktreeDir);
        else
            failedItems.push({
                worktreeDir: item.worktreeDir,
                reason: result.reason ?? 'unknown',
                ...(result.error ? { error: result.error } : {}),
            });
    }
    return { success: failedItems.length === 0, removedPaths, failedItems };
}
function parseWorktreeEntries(output) {
    return output
        .split(/\n\n+/u)
        .map((block) => Object.fromEntries(block
        .split('\n')
        .filter(Boolean)
        .map((line) => {
        const [key, ...rest] = line.split(' ');
        return [key, rest.join(' ')];
    })))
        .filter((entry) => Boolean(entry.worktree));
}
async function readGitRoot(workspace) {
    const result = await git(['rev-parse', '--show-toplevel'], workspace);
    if (result.code !== 0) {
        return { error: result.stderr || result.stdout || 'Not a git repository' };
    }
    return { root: result.stdout.trim(), error: 'Not a git repository' };
}
async function prepareWorktreeCreatePlan(root, options) {
    const branch = options.branch?.trim() || generateDefaultWorktreeBranch();
    if (!(await isValidWorktreeBranch(root, branch)))
        return { error: 'Invalid worktree branch' };
    const dirName = normalizeWorktreeDirName(options.dirName, branch);
    if (!dirName)
        return { error: 'Invalid worktree dirName' };
    const target = await resolveManagedWorktreeTarget(root, dirName);
    if (!target)
        return { error: 'Invalid worktree dirName' };
    return { plan: { branch, target, base: options.base?.trim() || 'HEAD' } };
}
async function isValidWorktreeBranch(root, branch) {
    if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0'))
        return false;
    const result = await git(['check-ref-format', `refs/heads/${branch}`], root);
    return result.code === 0;
}
function normalizeWorktreeDirName(dirName, branch) {
    const value = dirName?.trim() || branch.replace(/[^a-zA-Z0-9._-]+/gu, '-');
    if (!value ||
        value === '.' ||
        value === '..' ||
        isAbsolute(value) ||
        value !== basename(value) ||
        value.includes('\\'))
        return undefined;
    return value;
}
function generateDefaultWorktreeBranch() {
    const date = new Date();
    const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part) => String(part).padStart(2, '0'))
        .join('');
    return `feat/auto-${stamp}-${randomBytes(4).toString('hex')}`;
}
async function resolveManagedWorktreeTarget(root, dirName) {
    const managedParent = resolve(join(root, '.worktrees'));
    try {
        await mkdir(managedParent, { recursive: true });
        const [realRoot, realParent] = await Promise.all([realpath(root), realpath(managedParent)]);
        if (!isPathInside(realRoot, realParent))
            return undefined;
        const target = resolve(realParent, dirName);
        return isPathInside(realParent, target) && target !== realParent ? target : undefined;
    }
    catch {
        return undefined;
    }
}
function createWorktreeResult(result, plan) {
    if (result.code === 0) {
        return {
            success: true,
            worktreeDir: plan.target,
            branch: plan.branch,
            resolvedBase: plan.base,
        };
    }
    return { success: false, error: result.stderr || result.stdout || 'Failed to create worktree' };
}
function findWorktree(worktrees, target) {
    return worktrees?.find((item) => item.path && resolve(item.path) === resolve(target));
}
function validateManagedRemoval(entry, target, activeWorktreeDir, runningWorktreeDirs) {
    if (!entry) {
        return { status: 404, success: false, reason: 'not_found', error: 'Worktree was not found' };
    }
    if (entry.isMain) {
        return {
            status: 400,
            success: false,
            reason: 'main_worktree',
            error: 'The main worktree cannot be removed',
        };
    }
    const protectedPaths = [activeWorktreeDir, ...runningWorktreeDirs]
        .filter(Boolean)
        .map((path) => resolve(path));
    if (protectedPaths.some((path) => isPathInside(target, path))) {
        return {
            status: 409,
            success: false,
            reason: 'active_worktree',
            error: 'The worktree used by an active session cannot be removed',
        };
    }
    if (entry.isLocked) {
        return {
            status: 409,
            success: false,
            reason: 'locked_worktree',
            error: 'This worktree is locked',
        };
    }
    return undefined;
}
function removeWorktreeResult(result) {
    if (result.code === 0)
        return { status: 200, success: true };
    return {
        status: 500,
        success: false,
        reason: 'unknown',
        error: result.stderr || result.stdout || 'Failed to remove worktree',
    };
}
async function toWorktreeInfo(entry, context) {
    const worktreePath = String(entry.worktree);
    const [canonicalWorktreePath, lastModifiedMs] = await Promise.all([
        canonicalPath(worktreePath),
        readLastModifiedMs(worktreePath),
    ]);
    if (lastModifiedMs === null)
        return null;
    return {
        path: worktreePath,
        branch: String(entry.branch ?? '').replace(/^refs\/heads\//u, ''),
        head: String(entry.HEAD ?? ''),
        isMain: context.mainWorktreePath !== undefined &&
            resolve(worktreePath) === resolve(context.mainWorktreePath),
        isLocked: 'locked' in entry,
        isActive: canonicalWorktreePath === context.activeWorktreePath,
        isMcodeManaged: context.managedParent !== undefined &&
            isPathInside(context.managedParent, canonicalWorktreePath),
        ...(lastModifiedMs === undefined ? {} : { lastModifiedMs }),
    };
}
async function resolveManagedParent(mainWorktreePath) {
    if (!mainWorktreePath)
        return undefined;
    try {
        return await realpath(join(mainWorktreePath, '.worktrees'));
    }
    catch {
        return undefined;
    }
}
async function canonicalPath(target) {
    try {
        return await realpath(target);
    }
    catch {
        return resolve(target);
    }
}
async function readStat(target) {
    try {
        return await stat(target);
    }
    catch {
        return undefined;
    }
}
/** null means confirmed missing; undefined means metadata could not be read. */
async function readLastModifiedMs(target) {
    try {
        return Math.trunc(Number((await stat(target)).mtimeMs));
    }
    catch (error) {
        const code = error?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR')
            return null;
        return undefined;
    }
}
function isPathInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
//# sourceMappingURL=worktrees.js.map