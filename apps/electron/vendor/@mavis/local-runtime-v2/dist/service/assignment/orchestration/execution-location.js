import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { replaceFileAtomically } from '../../../infra/file/jsonl.js';
import { git } from '../../workspace/index.js';
import { executionLocationText } from '../../coordinator-text/index.js';
/**
 * The registered Project a Session belongs to, as a directory: the Project its creator named
 * (`projectWorkspaceDir`, written when the task runs in a directory inside it), else the
 * repository a worktree was made from, else the execution directory itself. A task running in
 * a directory inside a Project is shown, and scoped, as that Project and never as the
 * directory's own name.
 */
export function projectDirectoryOf(session) {
    return session.projectWorkspaceDir ?? session.runLocation?.parentRepoDir ?? session.workspaceDir;
}
export function executionLocationLabel(session) {
    if (session.isDefaultWorkspace)
        return executionLocationText({ worktree: false });
    return executionLocationText({
        project: path.basename(projectDirectoryOf(session)),
        worktree: session.runLocation?.mode.includes('worktree') === true,
    });
}
/** The record service's default name, chosen here so a failed create knows where it went. */
function newAssignmentWorktreeBranch(nowMs) {
    const date = new Date(nowMs);
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${String(date.getFullYear())}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    return `feat/auto-${stamp}-${randomBytes(4).toString('hex')}`;
}
/** Creates `dir` and returns the directories that did not exist before, outermost first. */
export async function claimDirectory(dir) {
    const first = await mkdir(dir, { recursive: true });
    if (first === undefined)
        return [];
    const created = [];
    for (let current = path.resolve(dir);; current = path.dirname(current)) {
        created.unshift(current);
        if (current === path.resolve(first) || current === path.dirname(current))
            break;
    }
    return created;
}
/**
 * Atomically writes a new file the call owns, e.g. a project task's `.link.json` pointer, and
 * returns what it created. A file already at `file` is left alone and not claimed. A failed
 * write gives back the (still empty) directories it created before throwing.
 */
export async function claimFile(file, contents) {
    const createdDirs = await claimDirectory(path.dirname(file));
    if (await exists(file))
        return { createdDirs };
    try {
        await replaceFileAtomically(file, contents);
    }
    catch (error) {
        await removeCreatedDirectories(createdDirs, { warn: () => undefined });
        throw error;
    }
    return { createdDirs, createdFiles: [file] };
}
/** Both claims together: a failed create gives back what either put on disk. */
export function mergeClaims(left, right) {
    return {
        ...left,
        createdDirs: [...left.createdDirs, ...right.createdDirs],
        createdFiles: [...(left.createdFiles ?? []), ...(right.createdFiles ?? [])],
    };
}
/**
 * Records the worktree the record service will create under `repoDir`, mirroring
 * its layout (`<realpath(repo)>/.worktrees/<branch with / as ->`). An already
 * present target or branch means the create will fail on its own and is not ours.
 * @internal Exported only for focused tests.
 */
export async function claimWorktree(repoDir, branch) {
    const repo = await realpath(repoDir);
    const parent = path.join(repo, '.worktrees');
    const dir = path.join(parent, branch.replaceAll('/', '-'));
    if (await exists(dir))
        return { createdDirs: [] };
    const branchExists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).code === 0;
    return {
        createdDirs: (await exists(parent)) ? [] : [parent],
        worktree: { repoDir: repo, dir, branch, ownsBranch: !branchExists },
    };
}
/**
 * Best-effort undo of a failed create. Never forces: `git worktree remove`
 * without `--force` refuses a worktree holding changes or untracked files, and
 * a directory is removed only when empty. Failures are logged, not thrown, so
 * the original create error reaches the caller.
 */
export async function releaseExecutionLocation(claim, logger) {
    const keptWorktree = claim.worktree ? await releaseWorktree(claim.worktree, logger) : false;
    const keptDir = keptWorktree ? claim.worktree?.dir : undefined;
    for (const file of claim.createdFiles ?? [])
        await removeCreatedFile(file, logger);
    await removeCreatedDirectories(claim.createdDirs.filter((dir) => !keptDir?.startsWith(`${dir}${path.sep}`)), logger);
}
/**
 * Removes the directories one call created, as listed by {@link claimDirectory}
 * (outermost first), innermost first. Only an empty directory is removed: one
 * that now holds anything is kept and logged. Never throws.
 * @internal Exported only for focused tests.
 */
export async function removeCreatedDirectories(createdDirs, logger) {
    for (const dir of [...createdDirs].reverse())
        await removeEmptyDirectory(dir, logger);
}
/** Returns whether the worktree directory had to be kept. */
async function releaseWorktree(worktree, logger) {
    let kept = false;
    if (await exists(worktree.dir)) {
        const removed = await git(['worktree', 'remove', worktree.dir], worktree.repoDir);
        if (removed.code !== 0) {
            // Not a registered worktree (e.g. `worktree add` failed half way): only an empty one goes.
            kept = !(await removeEmptyDirectory(worktree.dir, logger, removed.stderr.trim()));
        }
    }
    if (kept || !worktree.ownsBranch)
        return kept;
    const deleted = await git(['branch', '-D', worktree.branch], worktree.repoDir);
    const missing = /not found/i.test(deleted.stderr);
    if (deleted.code !== 0 && !missing)
        logger.warn({ event: 'assignment_rollback_branch_kept', branch: worktree.branch, error: deleted.stderr }, 'Could not delete the branch created for a failed assignment');
    return kept;
}
async function removeEmptyDirectory(dir, logger, reason) {
    try {
        if ((await readdir(dir)).length > 0) {
            logger.warn({ event: 'assignment_rollback_dir_kept', dir, ...(reason ? { reason } : {}) }, 'Kept a directory created for a failed assignment because it is not empty');
            return false;
        }
        await rmdir(dir);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return true;
        logger.warn({ event: 'assignment_rollback_dir_kept', dir, error: String(error) }, 'Could not remove a directory created for a failed assignment');
        return false;
    }
}
async function removeCreatedFile(file, logger) {
    try {
        await unlink(file);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        logger.warn({ event: 'assignment_rollback_file_kept', file, error: String(error) }, 'Could not remove a file created for a failed assignment');
    }
}
async function exists(target) {
    try {
        await stat(target);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Candidates so broad that containing a directory says nothing about the user's
 * intent: the filesystem root and the home directory match only themselves.
 * @internal Exported only for focused tests.
 */
export function broadRoots() {
    return [path.parse(process.cwd()).root, os.homedir()];
}
/**
 * The candidate that is `target` or contains it, the deepest when several do.
 * `target` must be an existing directory. Both sides are compared after `..`
 * and symlinks are resolved, so a path that only looks inside a project but
 * resolves elsewhere does not match. A directory inside a project runs at its
 * resolved path, so a symlink cannot be retargeted after this check.
 */
export async function containingProject(candidates, target, exactOnly = broadRoots()) {
    const real = await existingDirectory(path.resolve(target));
    if (!real)
        return undefined;
    const key = normalizeCase(real);
    const broad = new Set(await Promise.all(exactOnly.map(canonicalDirectory)));
    const resolved = await Promise.all(candidates.map(canonicalDirectory));
    let best;
    resolved.forEach((root, index) => {
        const match = containment(root, key);
        if (!match || (!match.exact && broad.has(root)))
            return;
        if (!best || match.depth > best.depth)
            best = { index, ...match };
    });
    const projectDir = best ? candidates[best.index] : undefined;
    if (!best || !projectDir)
        return undefined;
    // An exact candidate keeps its registered spelling.
    return {
        projectDir,
        projectName: path.basename(projectDir),
        directory: best.exact ? projectDir : real,
    };
}
/**
 * The Runtime's own working directory as the Project a task that names none runs in,
 * so a coordinator started in a repository dispatches into that repository instead of
 * an empty space directory. `undefined` leaves the task in its space's `artifacts/`:
 *
 * - no working directory, or one that is not an existing directory;
 * - a directory inside `internal`, which the Runtime owns rather than works in — a host
 *   that passes no working directory resolves `<dataDir>/workspace` and lands here;
 * - a root too broad to say anything about intent (the filesystem root, the home
 *   directory), the same exclusion `containingProject` applies.
 *
 * Both sides are compared after symlinks are resolved, so a link that only looks
 * outside `internal` does not slip through. The resolved path is what the task runs
 * in, so the directory cannot be retargeted after this check.
 */
export async function defaultProjectOf(directory, internal) {
    if (!directory?.trim())
        return undefined;
    const real = await existingDirectory(directory);
    if (!real)
        return undefined;
    const key = normalizeCase(real);
    const broad = await Promise.all(broadRoots().map(canonicalDirectory));
    if (broad.includes(key))
        return undefined;
    const owned = await Promise.all((internal ?? []).map(canonicalDirectory));
    if (owned.some((root) => containment(root, key) !== undefined))
        return undefined;
    return { projectDir: real, projectName: path.basename(real), directory: real };
}
/**
 * The repository a directory belongs to, as a worktree is made at its root:
 * `root` is the top level, `subPath` the directory relative to it ('' at the root).
 */
async function repositoryOf(directory) {
    const result = await git(['rev-parse', '--show-toplevel', '--show-prefix'], directory);
    if (result.code !== 0)
        return undefined;
    const [root = '', prefix = ''] = result.stdout.split(/\r?\n/);
    if (!root.trim())
        return undefined;
    return { root: root.trim(), subPath: prefix.trim().replace(/[\\/]+$/, '') };
}
/**
 * Where a project task starts. A worktree is always made at the repository
 * root, even for a directory inside it; `subPath` is then where the task runs
 * inside the new worktree. Outside git, or without a worktree, it runs in place.
 * `claim` records the worktree and branch the create will make, computed from
 * the same repository root the record service gets as `workspaceDir`, so a
 * failed create removes exactly them and never a sub directory.
 */
export async function projectStart(directory, worktree, nowMs) {
    const repository = worktree ? await repositoryOf(directory) : undefined;
    if (!repository) {
        if (worktree)
            throw new Error('A worktree requires a Git project');
        return { workspaceDir: directory, claim: { createdDirs: [] } };
    }
    // At the root keep the given spelling; inside, the worktree goes at the repository root.
    const workspaceDir = repository.subPath ? repository.root : directory;
    // Name the branch here so a failed create knows which worktree and branch it made.
    const newWorktreeBranch = newAssignmentWorktreeBranch(nowMs);
    return {
        workspaceDir,
        runLocation: { mode: 'new-worktree', newWorktreeBranch },
        ...(repository.subPath ? { subPath: repository.subPath } : {}),
        claim: await claimWorktree(workspaceDir, newWorktreeBranch),
    };
}
export async function isDirectory(directory) {
    return (await existingDirectory(directory)) !== undefined;
}
async function existingDirectory(directory) {
    try {
        const real = await realpath(directory);
        return (await stat(real)).isDirectory() ? real : undefined;
    }
    catch {
        return undefined;
    }
}
async function canonicalDirectory(directory) {
    try {
        return normalizeCase(await realpath(directory));
    }
    catch {
        return normalizeCase(path.resolve(directory));
    }
}
/** Whether `target` is `root` or below it, and how deep `root` is. */
function containment(root, target) {
    const relative = path.relative(root, target);
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (outside)
        return undefined;
    return { depth: root.split(path.sep).filter(Boolean).length, exact: relative === '' };
}
export function normalizeProjectDir(directory) {
    return normalizeCase(path.resolve(directory));
}
/** A name matches exactly one candidate's directory name; it never reaches inside a project. */
export function projectByName(dirs, name) {
    const matches = dirs.filter((dir) => path.basename(dir) === name);
    const projectDir = matches.length === 1 ? matches[0] : undefined;
    return projectDir
        ? { projectDir, projectName: path.basename(projectDir), directory: projectDir }
        : undefined;
}
function normalizeCase(directory) {
    return process.platform === 'win32' ? directory.toLowerCase() : directory;
}
//# sourceMappingURL=execution-location.js.map