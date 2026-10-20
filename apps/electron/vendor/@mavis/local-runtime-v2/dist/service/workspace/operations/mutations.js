import { rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, posix, resolve } from 'node:path';
import { isGitRepo, parsePorcelainStatus } from './changes.js';
import { git } from './git-process.js';
import { isPathInside, resolveWorkspaceWritePath } from './filesystem/workspace-path.js';
export async function saveWorkspaceFile(manager, workspace, filePath, content) {
    await manager.runMutation(workspace, 'workspace', async () => {
        const absolute = await resolveWorkspaceWritePath(workspace, filePath);
        if (!absolute)
            throw new Error('Path traversal denied');
        await writeFile(absolute, content, 'utf8');
    });
}
export async function checkoutBranch(manager, workspace, branch) {
    const invalid = await validateGitBranch(workspace, branch);
    if (invalid)
        return { success: false, error: invalid };
    return runGitMutation(manager, workspace, ['checkout', branch]);
}
export async function createBranch(manager, workspace, branch) {
    const invalid = await validateGitBranch(workspace, branch);
    if (invalid)
        return { success: false, error: invalid };
    return runGitMutation(manager, workspace, ['checkout', '-b', branch]);
}
export async function commit(manager, workspace, message, includeUnstaged = true) {
    return manager.runMutation(workspace, 'repository', async () => {
        if (includeUnstaged) {
            const add = await git(['add', '--all'], workspace);
            if (add.code !== 0)
                return toMutationResult(add);
        }
        return toMutationResult(await git(['commit', '-m', message], workspace));
    });
}
export async function commitAndPush(manager, workspace, message, includeUnstaged = true) {
    return manager.runMutation(workspace, 'repository', async () => {
        if (includeUnstaged) {
            const add = await git(['add', '--all'], workspace);
            if (add.code !== 0) {
                const commitResult = toMutationResult(add);
                return { success: false, commit: commitResult };
            }
        }
        const commitResult = toMutationResult(await git(['commit', '-m', message], workspace));
        if (!commitResult.success)
            return { success: false, commit: commitResult };
        const pushResult = toMutationResult(await pushWorkspace(workspace));
        return { success: pushResult.success, commit: commitResult, push: pushResult };
    });
}
export async function push(manager, workspace) {
    return manager.runMutation(workspace, 'repository', async () => toMutationResult(await pushWorkspace(workspace)));
}
export async function applyFileChangeAction(manager, workspace, options) {
    const { action, paths, scope = 'all' } = options;
    if (!(await isGitRepo(workspace)))
        return { success: false, error: 'Not a git repository' };
    let normalizedPaths;
    try {
        normalizedPaths = normalizeGitActionPaths(resolve(workspace), paths);
    }
    catch (error) {
        return { success: false, error: describeError(error) };
    }
    if (normalizedPaths.length === 0)
        return { success: false, error: 'No paths provided' };
    return manager.runMutation(workspace, 'repository', async () => {
        if (action === 'stage') {
            return toMutationResult(await git(['add', '--', ...normalizedPaths], workspace));
        }
        if (action === 'unstage') {
            return toMutationResult(await git(['restore', '--staged', '--', ...normalizedPaths], workspace));
        }
        if (scope === 'staged') {
            return {
                success: false,
                error: 'Staged changes cannot be discarded directly. Unstage them first.',
            };
        }
        return discardGitPaths(workspace, normalizedPaths);
    });
}
async function runGitMutation(manager, workspace, args) {
    return manager.runMutation(workspace, 'repository', async () => toMutationResult(await git(args, workspace)));
}
async function discardGitPaths(workspace, paths) {
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths], workspace);
    if (status.code !== 0)
        return toMutationResult(status);
    const untrackedPaths = parsePorcelainStatus(status.stdout).untrackedPaths;
    const trackedPaths = paths.filter((filePath) => !untrackedPaths.has(filePath));
    if (trackedPaths.length > 0) {
        const result = await git(['restore', '--worktree', '--', ...trackedPaths], workspace);
        if (result.code !== 0)
            return toMutationResult(result);
    }
    await Promise.all(Array.from(untrackedPaths, async (filePath) => {
        const absolutePath = resolve(workspace, ...filePath.split('/'));
        if (isPathInside(resolve(workspace), absolutePath)) {
            await rm(absolutePath, { recursive: true, force: true });
        }
    }));
    return { success: true };
}
function normalizeGitActionPaths(workspaceRoot, paths) {
    const normalizedPaths = new Set();
    for (const filePath of paths) {
        const normalized = normalizeGitActionPath(filePath);
        const absolutePath = resolve(join(workspaceRoot, ...normalized.split('/')));
        if (!isPathInside(workspaceRoot, absolutePath)) {
            throw new Error(`Path is outside workspace: ${filePath}`);
        }
        normalizedPaths.add(normalized);
    }
    return Array.from(normalizedPaths);
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
async function validateGitBranch(workspace, branch) {
    if (branch.startsWith('-') || branch.startsWith('@') || branch.includes('\0')) {
        return `Invalid git branch name: ${branch}`;
    }
    const check = await git(['check-ref-format', `refs/heads/${branch}`], workspace);
    return check.code === 0 ? undefined : `Invalid git branch name: ${check.stderr || check.stdout}`;
}
async function pushWorkspace(workspace) {
    const result = await git(['push'], workspace);
    if (result.code !== 0 && /no upstream branch|set-upstream|--set-upstream/i.test(result.stderr)) {
        return git(['push', '-u', 'origin', 'HEAD'], workspace);
    }
    return result;
}
function toMutationResult(result) {
    return result.code === 0
        ? { success: true, output: result.stdout || result.stderr }
        : { success: false, error: result.stderr || result.stdout };
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=mutations.js.map