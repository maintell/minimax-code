import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, gitRoot } from './git-process.js';
/**
 * Parses `git worktree list --porcelain`. Every caller that needs worktree
 * ownership or flags shares this parser so attribute handling stays identical.
 */
export function parseWorktreePorcelain(output) {
    return output
        .split(/\r?\n\r?\n+/u)
        .map((block) => Object.fromEntries(block
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => {
        const [key, ...rest] = line.split(' ');
        return [key, rest.join(' ')];
    })))
        .filter((entry) => typeof entry.worktree === 'string' && entry.worktree.length > 0);
}
/** Resolves symlinks and junctions when the path exists; falls back to a lexical path. */
export async function canonicalWorktreePath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return resolve(path);
    }
}
/**
 * The repository's registered worktrees with canonical paths and the flags that
 * decide whether one may be removed. Manual removal and automatic cleanup both
 * read ownership from here and only map the failures differently.
 */
export async function inspectRepositoryWorktrees(workspace) {
    const root = await gitRoot(workspace);
    if (!root)
        return { kind: 'not_repository' };
    const listed = await git(['worktree', 'list', '--porcelain'], root);
    if (listed.code !== 0) {
        return {
            kind: 'list_failed',
            error: listed.stderr || listed.stdout || 'Failed to inspect git worktrees',
        };
    }
    const raw = parseWorktreePorcelain(listed.stdout);
    const mainRoot = typeof raw[0]?.worktree === 'string' ? raw[0].worktree : root;
    const mainPath = await canonicalWorktreePath(mainRoot);
    const entries = await Promise.all(raw.map(async (entry) => {
        const path = await canonicalWorktreePath(String(entry.worktree));
        return {
            path,
            isMain: path === mainPath,
            isLocked: 'locked' in entry,
            ...(entry.branch ? { branch: entry.branch } : {}),
        };
    }));
    return { kind: 'listed', repository: { mainRoot, entries } };
}
/**
 * True only when `worktreeDir` is a worktree root registered by the repository
 * that owns `repoDir`. A failed listing is treated as "not registered".
 */
async function isRegisteredWorktreeOf(worktreeDir, repoDir) {
    const inspected = await inspectRepositoryWorktrees(repoDir);
    if (inspected.kind !== 'listed')
        return false;
    const target = await canonicalWorktreePath(worktreeDir);
    return inspected.repository.entries.some((entry) => entry.path === target);
}
/**
 * Repository an existing-worktree run location belongs to. When the caller did
 * not name a workspace, the repository is inferred from the worktree itself;
 * either way the worktree must be registered by that repository. Each
 * run-location entry only maps the failure to its own error type.
 */
export async function resolveExistingWorktreeRepository(worktreeDir, workspaceDir, workspaceDirImplicit) {
    const repoDir = workspaceDirImplicit ? await resolveWorktreeOwnerRepo(worktreeDir) : workspaceDir;
    if (!repoDir) {
        return {
            kind: 'not_in_repository',
            message: `Directory is not a worktree of a Git repository: ${worktreeDir}`,
        };
    }
    if (!(await isRegisteredWorktreeOf(worktreeDir, repoDir))) {
        return {
            kind: 'not_in_repository',
            message: `Directory is not a worktree of ${repoDir}: ${worktreeDir}`,
        };
    }
    return { kind: 'resolved', repoDir };
}
/**
 * Main worktree of the repository that owns `worktreeDir`. Used when a caller
 * names a worktree without naming its repository. Bare repositories and
 * directories outside Git yield `undefined`.
 */
async function resolveWorktreeOwnerRepo(worktreeDir) {
    const listed = await git(['worktree', 'list', '--porcelain'], worktreeDir);
    if (listed.code !== 0)
        return undefined;
    const main = parseWorktreePorcelain(listed.stdout)[0];
    if (!main || 'bare' in main)
        return undefined;
    return resolve(String(main.worktree));
}
/**
 * Runs `git worktree add -b` and, when it fails, deletes the branch only if a
 * pre-flight probe proved the branch did not exist (exit code 1). Any other
 * probe result keeps the branch because this call cannot prove it owns it.
 */
export async function addWorktreeWithNewBranch(input) {
    const { repoDir, branch, targetDir, base } = input;
    const branchProbe = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoDir);
    const result = await git(['worktree', 'add', '-b', branch, targetDir, ...(base ? [base] : [])], repoDir);
    if (result.code !== 0 && branchProbe.code === 1) {
        await git(['branch', '-D', branch], repoDir);
    }
    return result;
}
//# sourceMappingURL=worktree-registry.js.map