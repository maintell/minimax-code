import { existsSync } from 'node:fs';
import { readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git } from '../operations/git-process.js';
import { canonicalWorktreePath, inspectRepositoryWorktrees, } from '../operations/worktree-registry.js';
/** Snapshot commits live outside branches/tags so they never show up in normal history. */
const SNAPSHOT_REF_PREFIX = 'refs/mcode/snapshots/';
/**
 * Written into the worktree's administrative directory before removal starts.
 * `git worktree remove` deletes that directory last, so the marker proves that
 * a registered worktree at the original path is the one this cleanup was
 * removing, not a worktree created there afterwards.
 */
const CLEANUP_MARKER_FILE = 'mcode-cleanup';
const SNAPSHOT_IDENTITY = {
    GIT_AUTHOR_NAME: 'MCode',
    GIT_AUTHOR_EMAIL: 'mcode@localhost',
    GIT_COMMITTER_NAME: 'MCode',
    GIT_COMMITTER_EMAIL: 'mcode@localhost',
};
export const WORKTREE_SNAPSHOT_MISSING_MESSAGE = 'The archived worktree snapshot is missing.';
/** @internal Exported only for focused tests. */
export function worktreeSnapshotRef(snapshotId) {
    return SNAPSHOT_REF_PREFIX + snapshotId;
}
/** Lists the repository's registered worktrees; undefined when they cannot be read. */
export async function listCleanupRepositoryWorktrees(workspace) {
    const inspected = await inspectRepositoryWorktrees(workspace);
    return inspected.kind === 'listed' ? inspected.repository : undefined;
}
/**
 * Whether the directory still belongs to an intact linked worktree. It may be
 * the worktree root or a directory inside it. A partially removed worktree that
 * lost its `.git` file would otherwise resolve to the enclosing repository,
 * which is never a linked worktree here.
 */
export async function worktreeCheckoutPresent(dir) {
    return (await linkedWorktreeAdminDir(dir)) !== undefined;
}
/** Creation time of a worktree directory; undefined when it cannot be read. */
export async function worktreeCreatedAtMs(worktreeDir) {
    try {
        const info = await stat(worktreeDir);
        const birth = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
        return Math.trunc(birth);
    }
    catch {
        return undefined;
    }
}
/** Administrative directory of the intact linked worktree containing the directory. */
async function linkedWorktreeAdminDir(worktreeDir) {
    try {
        if (!(await stat(worktreeDir)).isDirectory())
            return undefined;
    }
    catch {
        return undefined;
    }
    const dir = await git(['rev-parse', '--absolute-git-dir'], worktreeDir);
    const adminDir = dir.code === 0 ? dir.stdout.trim() : '';
    // Only linked worktrees have a gitdir back-pointer; never mark the main repository.
    return adminDir && existsSync(join(adminDir, 'gitdir')) ? adminDir : undefined;
}
/** Marks the worktree as being removed by the given cleanup; false when it cannot be marked. */
export async function markWorktreeCleanup(worktreeDir, cleanupId) {
    const adminDir = await linkedWorktreeAdminDir(worktreeDir);
    if (!adminDir)
        return false;
    try {
        await writeFile(join(adminDir, CLEANUP_MARKER_FILE), cleanupId, 'utf8');
        return true;
    }
    catch {
        return false;
    }
}
/** Drops the marker of the given cleanup; a worktree that is gone or re-created keeps no marker. */
export async function clearWorktreeCleanupMarker(worktreeDir, cleanupId) {
    const adminDir = await linkedWorktreeAdminDir(worktreeDir);
    if (adminDir && (await readCleanupMarker(adminDir)) === cleanupId) {
        await removeQuietly(join(adminDir, CLEANUP_MARKER_FILE));
    }
}
async function readCleanupMarker(adminDir) {
    try {
        return (await readFile(join(adminDir, CLEANUP_MARKER_FILE), 'utf8')).trim();
    }
    catch {
        return undefined;
    }
}
/**
 * Whether the worktree at the original path is the one the given cleanup was
 * removing and is still at the recorded HEAD, so replaying the snapshot cannot
 * overwrite work done after the cleanup.
 */
async function isInterruptedCleanup(input) {
    if (!input.cleanupId)
        return false;
    const adminDir = await linkedWorktreeAdminDir(input.worktreeDir);
    if (!adminDir || (await readCleanupMarker(adminDir)) !== input.cleanupId)
        return false;
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], input.worktreeDir);
    return head.code === 0 && head.stdout.trim() === input.head;
}
function snapshotIndexFile(snapshotId) {
    return join(tmpdir(), `mcode-worktree-snapshot-${snapshotId}.index`);
}
/**
 * Records the worktree state before cleanup. Changes, including untracked but
 * not ignored files, are written into a detached commit through a temporary
 * index so the user's index and index.lock are never touched. The index is
 * kept for worktreeMatchesSnapshot until releaseWorktreeSnapshot drops it.
 */
export async function snapshotWorktreeForCleanup(worktreeDir, snapshotId, signal) {
    const run = (args, env) => git(args, worktreeDir, { ...(signal ? { signal } : {}), ...(env ? { env } : {}) });
    const source = await inspectSnapshotSource(worktreeDir, run);
    if (source.kind === 'skipped')
        return source;
    const base = {
        kind: 'snapshotted',
        head: source.head,
        ...(source.branch ? { branch: source.branch } : {}),
    };
    if (!source.dirty) {
        const snapshotRef = worktreeSnapshotRef(snapshotId);
        const pinned = await run(['update-ref', snapshotRef, source.head]);
        return pinned.code === 0 ? { ...base, snapshotRef } : snapshotFailure(pinned);
    }
    const indexFile = snapshotIndexFile(snapshotId);
    try {
        const outcome = await writeSnapshotCommit(run, base, snapshotId, indexFile);
        if (outcome.kind === 'skipped')
            await removeQuietly(indexFile);
        return outcome;
    }
    finally {
        await removeQuietly(`${indexFile}.lock`);
    }
}
/**
 * Whether the worktree still holds exactly what the snapshot recorded: same
 * HEAD and branch, and the same content in every file that is not ignored.
 * Work written after the snapshot would otherwise be removed without a copy.
 * Reuses the snapshot's index, so only files touched since then are hashed.
 */
export async function worktreeMatchesSnapshot(worktreeDir, snapshotId, snapshot, signal) {
    const run = (args, env) => git(args, worktreeDir, { ...(signal ? { signal } : {}), ...(env ? { env } : {}) });
    const source = await inspectSnapshotSource(worktreeDir, run);
    if (source.kind === 'skipped' || source.head !== snapshot.head)
        return false;
    if ((source.branch ?? '') !== (snapshot.branch ?? ''))
        return false;
    const expected = await run(['rev-parse', '--verify', '-q', `${snapshot.snapshotRef}^{tree}`]);
    if (expected.code !== 0 || !expected.stdout.trim())
        return false;
    const actual = source.dirty
        ? await currentWorktreeTree(run, snapshot.head, snapshotIndexFile(snapshotId))
        : await run(['rev-parse', '--verify', '-q', 'HEAD^{tree}']);
    return actual.code === 0 && actual.stdout.trim() === expected.stdout.trim();
}
/** Drops the temporary index a snapshot kept for worktreeMatchesSnapshot. */
export async function releaseWorktreeSnapshot(snapshotId) {
    const indexFile = snapshotIndexFile(snapshotId);
    await removeQuietly(indexFile);
    await removeQuietly(`${indexFile}.lock`);
}
async function currentWorktreeTree(run, head, indexFile) {
    const env = { GIT_INDEX_FILE: indexFile };
    if (!existsSync(indexFile)) {
        const read = await run(['read-tree', head], env);
        if (read.code !== 0)
            return read;
    }
    const added = await run(['add', '-A', '--', '.'], env);
    return added.code === 0 ? run(['write-tree'], env) : added;
}
async function inspectSnapshotSource(worktreeDir, run) {
    const head = await run(['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.code !== 0 || !head.stdout.trim())
        return { kind: 'skipped', reason: 'unborn_head' };
    const symbolic = await run(['symbolic-ref', '-q', '--short', 'HEAD']);
    const branch = symbolic.code === 0 ? symbolic.stdout.trim() : '';
    if (existsSync(join(worktreeDir, '.gitmodules')))
        return { kind: 'skipped', reason: 'submodules' };
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (status.code !== 0) {
        return { kind: 'skipped', reason: 'unknown', error: status.stderr || status.stdout };
    }
    const entries = status.stdout.split('\0').filter((entry) => entry.length > 3);
    if (entries.some((entry) => isNestedRepositoryEntry(worktreeDir, entry))) {
        return { kind: 'skipped', reason: 'nested_repository' };
    }
    return {
        kind: 'ready',
        head: head.stdout.trim(),
        ...(branch ? { branch } : {}),
        dirty: entries.length > 0,
    };
}
/** Writes the working tree into a detached commit through a temporary index. */
async function writeSnapshotCommit(run, base, snapshotId, indexFile) {
    const env = { GIT_INDEX_FILE: indexFile };
    // Shares the tree computation with worktreeMatchesSnapshot so both count the same files.
    const tree = await currentWorktreeTree(run, base.head, indexFile);
    if (tree.code !== 0)
        return snapshotFailure(tree);
    const commit = await run(['commit-tree', tree.stdout.trim(), '-p', base.head, '-m', 'MCode worktree snapshot'], { ...env, ...SNAPSHOT_IDENTITY });
    if (commit.code !== 0)
        return snapshotFailure(commit);
    const snapshotRef = worktreeSnapshotRef(snapshotId);
    const updated = await run(['update-ref', snapshotRef, commit.stdout.trim()]);
    if (updated.code !== 0)
        return snapshotFailure(updated);
    return { ...base, snapshotRef };
}
async function removeQuietly(path, directory = false) {
    try {
        await (directory ? rmdir(path) : rm(path, { force: true }));
    }
    catch {
        // Best effort: a leftover temporary file never affects the worktree.
    }
}
/** Removes a snapshotted worktree; its branch is always kept. */
export async function removeWorktreeForCleanup(mainRoot, worktreeDir, signal) {
    const result = await git(['worktree', 'remove', '--force', '--', worktreeDir], mainRoot, signal ? { signal } : {});
    return result.code === 0
        ? { ok: true }
        : { ok: false, error: result.stderr || result.stdout || 'Failed to remove worktree' };
}
export async function deleteWorktreeSnapshotRef(repoDir, snapshotRef) {
    if (!snapshotRef.startsWith(SNAPSHOT_REF_PREFIX))
        return;
    await git(['update-ref', '-d', snapshotRef], repoDir);
}
/**
 * Re-creates a cleaned worktree at its original path. The original branch is
 * reused only while it still points at the recorded HEAD and is not checked out
 * elsewhere; otherwise the worktree is detached at the recorded HEAD. Snapshot
 * content is replayed into the working tree as uncommitted changes.
 */
export async function restoreCleanedWorktree(input) {
    const source = await resolveRestoreSource(input);
    if (!source) {
        return { kind: 'failed', reason: 'snapshot_missing', error: WORKTREE_SNAPSHOT_MISSING_MESSAGE };
    }
    const listed = await listCleanupRepositoryWorktrees(input.repoDir);
    if (!listed)
        return { kind: 'failed', reason: 'unknown', error: 'Not a git repository' };
    const targetPath = await canonicalWorktreePath(input.worktreeDir);
    const registered = listed.entries.some((entry) => entry.path === targetPath);
    const pathState = await inspectRestorePath(input.worktreeDir);
    if (pathState === 'occupied' && registered)
        return repairInPlace(input, source, listed);
    if (pathState === 'occupied') {
        return {
            kind: 'failed',
            reason: 'path_occupied',
            error: 'The original worktree path is already in use',
        };
    }
    if (pathState === 'empty')
        await removeQuietly(input.worktreeDir, true);
    const plan = await planRestoreCheckout(input, listed);
    const failure = await addRestoredWorktree(input, listed.mainRoot, registered, plan);
    if (failure)
        return failure;
    // If the replay below is interrupted or fails, the next restore repairs it in place.
    if (input.cleanupId)
        await markWorktreeCleanup(input.worktreeDir, input.cleanupId);
    return replaySnapshot(input.worktreeDir, source, plan.detached
        ? { detached: true, detachReason: plan.reason }
        : { detached: false, branch: plan.branch });
}
/**
 * A previous cleanup stopped before or while removing the directory: repair it
 * in place. A clean worktree is replayed from HEAD so deleted files return.
 * Anything that cannot be proven to be that interrupted worktree is left alone.
 */
async function repairInPlace(input, source, repository) {
    if (!(await worktreeCheckoutPresent(input.worktreeDir))) {
        return {
            kind: 'failed',
            reason: 'unknown',
            error: 'The partially removed worktree can no longer be repaired in place',
        };
    }
    if (!(await isInterruptedCleanup(input))) {
        return {
            kind: 'failed',
            reason: 'path_occupied',
            error: 'The original worktree path is already in use',
        };
    }
    return replaySnapshot(input.worktreeDir, { ...source, hasChanges: true }, await describeRepairedCheckout(input, repository));
}
/**
 * Reports what the repaired worktree actually has checked out: an earlier
 * restore may have detached it because the original branch was unavailable.
 */
async function describeRepairedCheckout(input, repository) {
    const symbolic = await git(['symbolic-ref', '-q', '--short', 'HEAD'], input.worktreeDir);
    const branch = symbolic.code === 0 ? symbolic.stdout.trim() : '';
    if (branch)
        return { detached: false, branch };
    const plan = await planRestoreCheckout(input, repository);
    return plan.detached ? { detached: true, detachReason: plan.reason } : { detached: true };
}
async function addRestoredWorktree(input, mainRoot, registered, plan) {
    const target = plan.detached
        ? ['--detach', '--', input.worktreeDir, input.head]
        : ['--', input.worktreeDir, plan.branch];
    const added = await git(['worktree', 'add', ...(registered ? ['-f'] : []), ...target], mainRoot);
    if (added.code === 0)
        return undefined;
    return {
        kind: 'failed',
        reason: 'unknown',
        error: added.stderr || added.stdout || 'git worktree add failed',
    };
}
async function resolveRestoreSource(input) {
    if (input.snapshotRef) {
        const ref = await git(['rev-parse', '--verify', '-q', `${input.snapshotRef}^{commit}`], input.repoDir);
        return ref.code === 0 && ref.stdout.trim()
            ? { sha: ref.stdout.trim(), hasChanges: true }
            : undefined;
    }
    const head = await git(['cat-file', '-e', `${input.head}^{commit}`], input.repoDir);
    return head.code === 0 ? { sha: input.head, hasChanges: false } : undefined;
}
async function inspectRestorePath(path) {
    try {
        const info = await stat(path);
        if (!info.isDirectory())
            return 'occupied';
        return (await readdir(path)).length === 0 ? 'empty' : 'occupied';
    }
    catch {
        return 'missing';
    }
}
async function planRestoreCheckout(input, repository) {
    if (!input.branch)
        return { detached: true, reason: 'branch_missing' };
    const ref = `refs/heads/${input.branch}`;
    const tip = await git(['rev-parse', '--verify', '-q', ref], repository.mainRoot);
    if (tip.code !== 0 || !tip.stdout.trim())
        return { detached: true, reason: 'branch_missing' };
    if (tip.stdout.trim() !== input.head)
        return { detached: true, reason: 'branch_moved' };
    // A stale registration left at the target path itself does not hold the branch.
    const targetPath = await canonicalWorktreePath(input.worktreeDir);
    return repository.entries.some((entry) => entry.branch === ref && entry.path !== targetPath)
        ? { detached: true, reason: 'branch_in_use' }
        : { detached: false, branch: input.branch };
}
async function replaySnapshot(worktreeDir, source, result) {
    if (source.hasChanges) {
        const restored = await git(['restore', `--source=${source.sha}`, '--worktree', '--', '.'], worktreeDir);
        if (restored.code !== 0) {
            return {
                kind: 'failed',
                reason: 'unknown',
                error: restored.stderr || restored.stdout || 'Failed to replay the worktree snapshot',
            };
        }
    }
    return { kind: 'restored', ...result };
}
function isNestedRepositoryEntry(worktreeDir, entry) {
    if (!entry.startsWith('?? ') || !entry.endsWith('/'))
        return false;
    return existsSync(join(resolve(worktreeDir), entry.slice(3), '.git'));
}
function snapshotFailure(result) {
    return { kind: 'skipped', reason: 'unknown', error: result.stderr || result.stdout };
}
//# sourceMappingURL=worktree-snapshots.js.map