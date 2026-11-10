import { mkdir, lstat, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputerUseError } from './contracts.js';
/** One lock per OS account, deliberately independent of product/profile/owner. */
export function desktopLockRoot() {
    return path.join(homedir(), '.minimax-computer-use', 'locks');
}
/**
 * Creates missing runtime directories as 0700. The permissions, ownership and links of the
 * user's home and other existing ancestors are left alone: they are user environment, and
 * component integrity is enforced by manifest hashes rather than by directory modes.
 */
export async function privateDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
}
/** Signal-0 probe; EPERM means the PID exists under another account and counts as alive. */
export function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code !== 'ESRCH';
    }
}
const LOCK_NAME = 'control.lock';
const OWNER_FILE = 'owner.json';
const DAEMON_FILE = 'daemon.json';
/**
 * The lock directory is published by renaming a fully written staging directory, so a
 * visible lock always carries its owner record. A lock is reclaimed only when its host
 * process has exited and any recorded daemon is confirmed stopped; never on age alone.
 */
export async function acquireDesktopLock(root, ownerId, options = {}) {
    await privateDirectory(root);
    const directory = path.join(root, LOCK_NAME);
    const token = randomUUID();
    const content = JSON.stringify({ token, pid: process.pid, ownerId, createdAt: Date.now() });
    let recovered;
    for (let attempt = 0;; attempt++) {
        if (await publishLock(root, directory, token, content))
            break;
        if (attempt >= 2)
            throw new ComputerUseError('computer_busy', 'Another control session acquired the desktop at the same time; retry shortly.');
        recovered = (await reclaimStaleLock(root, directory, token, options)) ?? recovered;
    }
    const ownerFile = path.join(directory, OWNER_FILE);
    const daemonFile = path.join(directory, DAEMON_FILE);
    let recordedDaemon = '';
    let released = false;
    const assertOwned = async () => {
        if ((await readFile(ownerFile, 'utf8')) !== content) {
            throw new ComputerUseError('computer_lock_ownership_lost', 'Desktop lock ownership changed; cleanup was refused.');
        }
    };
    return {
        recovered,
        async recordDaemon(daemon) {
            if (released)
                return;
            const next = daemon ? JSON.stringify({ pid: daemon.pid, endpoint: daemon.endpoint }) : '';
            if (next === recordedDaemon)
                return;
            await assertOwned();
            if (!daemon)
                await rm(daemonFile, { force: true });
            else {
                const staged = path.join(directory, `${DAEMON_FILE}.${randomUUID()}`);
                await writeFile(staged, next, { flag: 'wx', mode: 0o600 });
                await rename(staged, daemonFile);
            }
            recordedDaemon = next;
        },
        async release() {
            if (released)
                return;
            await assertOwned();
            // Move the verified lock out of the shared name first so no successor can observe a
            // half-deleted lock directory.
            const retired = path.join(root, `.${LOCK_NAME}.${token}.released`);
            await rename(directory, retired);
            released = true;
            await rm(retired, { recursive: true, force: true });
        },
    };
}
async function publishLock(root, directory, token, content) {
    // POSIX rename replaces an empty directory; an empty lock left by an older client stays
    // fail-closed instead of being overwritten.
    if (await exists(directory))
        return false;
    const staging = path.join(root, `.${LOCK_NAME}.${token}`);
    await mkdir(staging, { mode: 0o700 });
    try {
        await writeFile(path.join(staging, OWNER_FILE), content, { flag: 'wx', mode: 0o600 });
        try {
            await rename(staging, directory);
            return true;
        }
        catch (error) {
            // POSIX reports ENOTEMPTY/EEXIST and Windows EPERM for an existing lock directory.
            if (await exists(directory))
                return false;
            throw error;
        }
    }
    finally {
        await rm(staging, { recursive: true, force: true });
    }
}
/** Returns recovery evidence, undefined when the lock vanished, or throws computer_busy. */
async function reclaimStaleLock(root, directory, token, options) {
    const owner = await readOwner(directory);
    if (owner === null)
        return undefined;
    if (!owner)
        throw new ComputerUseError('computer_busy', `Desktop control lock ${directory} has no valid owner record. Confirm no MiniMax Computer Use task is running, then remove that directory.`);
    const heldMs = Math.max(0, Date.now() - owner.createdAt);
    if (processAlive(owner.pid))
        throw new ComputerUseError('computer_busy', `Computer Use is in use by ${owner.ownerId} (pid ${owner.pid}, held ${Math.round(heldMs / 1000)}s). Wait for that task to finish or quit that app, then retry.`);
    const daemon = await readDaemon(directory);
    if (daemon === undefined)
        throw new ComputerUseError('computer_busy', `The previous Computer Use owner (pid ${owner.pid}) exited, but its daemon record is unreadable; the lock at ${directory} was kept.`);
    let daemonStopped = false;
    if (daemon && processAlive(daemon.pid)) {
        try {
            if (!options.stopOrphanDaemon)
                throw new Error('no daemon stopper');
            await options.stopOrphanDaemon(daemon);
            daemonStopped = true;
        }
        catch (error) {
            throw new ComputerUseError('computer_busy', `The previous Computer Use owner (pid ${owner.pid}) exited, but its daemon (pid ${daemon.pid}) could not be confirmed stopped: ${error instanceof ComputerUseError ? error.code : 'unreachable'}. Quit MiniMax Computer Use from Activity Monitor/Task Manager, then retry.`);
        }
    }
    // Another successor may have reclaimed and re-acquired while the daemon was stopping.
    const current = await readOwner(directory);
    if (!current || current.raw !== owner.raw)
        return undefined;
    const stale = path.join(root, `.${LOCK_NAME}.${token}.stale`);
    try {
        await rename(directory, stale);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const moved = await readOwner(stale);
    if (!moved || moved.raw !== owner.raw) {
        // Lost a reclaim race between the check and the move; hand the live lock back.
        await rename(stale, directory).catch(() => undefined);
        throw new ComputerUseError('computer_busy', 'Another control session acquired the desktop at the same time; retry shortly.');
    }
    await rm(stale, { recursive: true, force: true });
    return { ownerId: owner.ownerId, pid: owner.pid, heldMs, daemonStopped };
}
/** null: lock directory is gone; undefined: present but without a valid owner record. */
async function readOwner(directory) {
    let raw;
    try {
        raw = await readFile(path.join(directory, OWNER_FILE), 'utf8');
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        return (await exists(directory)) ? undefined : null;
    }
    try {
        const value = JSON.parse(raw);
        if (typeof value.pid !== 'number' ||
            !Number.isSafeInteger(value.pid) ||
            value.pid < 1 ||
            typeof value.ownerId !== 'string' ||
            typeof value.createdAt !== 'number')
            return undefined;
        return { raw, ownerId: value.ownerId, pid: value.pid, createdAt: value.createdAt };
    }
    catch {
        return undefined;
    }
}
/** null: no daemon was recorded; undefined: a record exists but is invalid. */
async function readDaemon(directory) {
    let raw;
    try {
        raw = await readFile(path.join(directory, DAEMON_FILE), 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    try {
        const value = JSON.parse(raw);
        if (typeof value.pid !== 'number' ||
            !Number.isSafeInteger(value.pid) ||
            value.pid < 1 ||
            typeof value.endpoint !== 'string' ||
            !value.endpoint)
            return undefined;
        return { pid: value.pid, endpoint: value.endpoint };
    }
    catch {
        return undefined;
    }
}
async function exists(target) {
    try {
        await lstat(target);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
//# sourceMappingURL=desktop-lock.js.map