import { mkdir, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { generateDefaultWorktreeBranch } from '../worktree-branch.js';
import { git } from './git-process.js';
import { addWorktreeWithNewBranch, canonicalWorktreePath as canonicalPath, parseWorktreePorcelain, } from './worktree-registry.js';
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
    const entries = parseWorktreePorcelain(result.stdout);
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
    const result = await addWorktreeWithNewBranch({
        repoDir: rootResult.root,
        branch: plan.plan.branch,
        targetDir: plan.plan.target,
        base: plan.plan.base,
    });
    return createWorktreeResult(result, plan.plan);
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