import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveV2DirectoryContract } from './local-runtime-paths.js';
/**
 * Cross-process migration lock: one process per dataDir may run the v2 layout
 * migration and database initialization at a time. `O_EXCL` file creation,
 * `process.kill(pid, 0)` liveness probing and an mtime heartbeat are portable
 * Node primitives (Windows/macOS), the same pattern as the sqlite snapshot
 * publish lock in `v2-migration.ts`. The primitive lives in `@mavis/shared`
 * (zero runtime dependencies) and `@mavis/local-runtime` re-exports it. See
 * `.harness/docs/adr/local-runtime-migration-fault-tolerance.md`.
 */
const MIGRATION_LOCK_FILE = 'migration.lock';
/** Exclusive guard next to the lock that serializes abandoned-lock reclaimers. */
const RECLAIM_GUARD_SUFFIX = '.reclaim';
/** Age after which a reclaim guard is treated as left behind by a crashed reclaimer. */
const RECLAIM_GUARD_STALE_MS = 30_000;
/** Upper bound on the holder heartbeat interval; see `heartbeatIntervalFor`. */
const MAX_HEARTBEAT_INTERVAL_MS = 60_000;
const MIGRATION_LOCK_TIMEOUT_ERROR_CODE = 'LOCAL_RUNTIME_MIGRATION_LOCK_TIMEOUT';
export class LocalRuntimeMigrationLockTimeoutError extends Error {
    code = MIGRATION_LOCK_TIMEOUT_ERROR_CODE;
    lockFilePath;
    holderPid;
    constructor(lockFilePath, waitedMs, holderPid) {
        super(`local-runtime migration lock timeout after ${waitedMs}ms${holderPid === undefined ? '' : ` (held by pid ${holderPid})`}`);
        this.name = 'LocalRuntimeMigrationLockTimeoutError';
        this.lockFilePath = lockFilePath;
        this.holderPid = holderPid;
    }
}
export async function acquireLocalRuntimeMigrationLock(options) {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 200);
    const staleMs = options.staleMs ?? 900_000;
    const now = options.nowFn ?? Date.now;
    const contract = resolveV2DirectoryContract(options.dataDir);
    const lockFilePath = path.join(contract.migration, MIGRATION_LOCK_FILE);
    ensureManagedMigrationDirectory(contract.root, contract.migration);
    const startedAtMs = now();
    for (;;) {
        const acquired = tryAcquireLockFile(lockFilePath, now, heartbeatIntervalFor(staleMs));
        if (acquired)
            return acquired;
        const holder = inspectLockHolder(lockFilePath, staleMs, options.isPidAliveFn);
        const waitedMs = Math.max(0, now() - startedAtMs);
        if (waitedMs >= timeoutMs) {
            throw new LocalRuntimeMigrationLockTimeoutError(lockFilePath, waitedMs, holder.pid);
        }
        // The holder vanished between the failed exclusive create and the read:
        // retry the create immediately.
        if (holder.kind === 'gone')
            continue;
        // A dead holder (or an expired unparseable file) is broken immediately.
        // A reclaim that loses the race or hits a Windows sharing violation
        // degrades to one more poll round instead of an error.
        if (holder.kind === 'abandoned' &&
            reclaimAbandonedLock(lockFilePath, staleMs, options.isPidAliveFn)) {
            continue;
        }
        await sleep(pollIntervalMs);
    }
}
function tryAcquireLockFile(lockFilePath, now, heartbeatIntervalMs) {
    let fd;
    try {
        fd = fs.openSync(lockFilePath, 'wx');
    }
    catch (error) {
        if (hasCode(error, 'EEXIST'))
            return undefined;
        throw error;
    }
    // The token makes the payload unique to this acquisition, so release can
    // tell its own lock from a successor's at the same path.
    const payload = `${JSON.stringify({ pid: process.pid, acquiredAtMs: now(), token: randomUUID() })}\n`;
    let ownedPayload;
    try {
        fs.writeSync(fd, payload);
        ownedPayload = payload;
    }
    catch {
        // Losing the payload only weakens diagnostics for other waiters; the
        // exclusively created file itself is the lock.
    }
    // Waiters judge the lock by how long its mtime has stood still, so a live
    // holder keeps it fresh for as long as the migration runs; a killed one
    // stops beating. The timer never keeps the process alive.
    const heartbeat = setInterval(() => {
        try {
            const beatAt = new Date();
            fs.futimesSync(fd, beatAt, beatAt);
        }
        catch {
            // A missed beat only lets waiters judge the lock stale sooner.
        }
    }, heartbeatIntervalMs);
    heartbeat.unref();
    let released = false;
    return {
        lockFilePath,
        release: () => {
            if (released)
                return;
            released = true;
            // Stop beating before the descriptor closes: a later beat would touch
            // whichever file reuses the descriptor number.
            clearInterval(heartbeat);
            removeOwnLockFile(lockFilePath, fd, ownedPayload);
            closeQuietly(fd);
        },
    };
}
/**
 * Release removes the lock only while it is still this holder's. A holder
 * whose heartbeat stalled past staleMs (one long synchronous stretch) may have
 * been reclaimed, and the file at the path may now belong to a successor;
 * deleting it would let a third process in while the successor migrates.
 * The check runs under the reclaim guard, so no reclaimer can swap the file
 * between the check and the removal. Ownership is the payload this holder
 * wrote, or, when that write failed, the identity of the still-open
 * descriptor (an open file keeps its inode, so a successor's cannot match).
 * Without the guard the file is handed to the guarded reclaim path instead.
 */
function removeOwnLockFile(lockFilePath, fd, ownedPayload) {
    const guardPath = `${lockFilePath}${RECLAIM_GUARD_SUFFIX}`;
    const guardFd = acquireReclaimGuardBriefly(guardPath);
    if (guardFd === undefined) {
        markOwnLockFileAbandoned(fd);
        return;
    }
    try {
        if (isOwnLockFile(lockFilePath, fd, ownedPayload))
            removeLockFile(lockFilePath);
    }
    finally {
        closeQuietly(guardFd);
        removeLockFile(guardPath);
    }
}
/**
 * Without the guard a check-then-remove is unprotected, so the file stays and
 * is backdated through this holder's own descriptor instead: it reads as
 * abandoned at once and the next waiter reclaims it under the guard as soon as
 * the guard frees (a crashed reclaimer's guard clears after 30s). The
 * descriptor can only reach this holder's file, never a successor's.
 */
function markOwnLockFileAbandoned(fd) {
    try {
        fs.futimesSync(fd, 0, 0);
    }
    catch {
        // The lock then expires staleMs after its last heartbeat instead.
    }
}
function isOwnLockFile(lockFilePath, fd, ownedPayload) {
    try {
        if (ownedPayload !== undefined)
            return fs.readFileSync(lockFilePath, 'utf8') === ownedPayload;
        const own = fs.fstatSync(fd);
        const current = fs.statSync(lockFilePath);
        return own.dev === current.dev && own.ino === current.ino;
    }
    catch {
        // Gone, or unreadable for now: leave it; an orphan expires like any lock.
        return false;
    }
}
/**
 * Reclaimers hold the guard for microseconds, so a short synchronous wait
 * normally gets it; a guard older than RECLAIM_GUARD_STALE_MS belongs to a
 * crashed reclaimer and is cleared. Returns undefined when it stays busy.
 */
function acquireReclaimGuardBriefly(guardPath) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            return fs.openSync(guardPath, 'wx');
        }
        catch (error) {
            if (!hasCode(error, 'EEXIST'))
                return undefined;
            if (isLockFileOlderThan(guardPath, RECLAIM_GUARD_STALE_MS))
                removeLockFile(guardPath);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
    }
    return undefined;
}
function inspectLockHolder(lockFilePath, staleMs, isPidAliveFn = isPidAlive) {
    let raw;
    try {
        raw = fs.readFileSync(lockFilePath, 'utf8');
    }
    catch (error) {
        if (hasCode(error, 'ENOENT'))
            return { kind: 'gone' };
        return { kind: 'held' };
    }
    const holderPid = parseHolderPid(raw);
    if (holderPid === undefined) {
        return isLockFileOlderThan(lockFilePath, staleMs) ? { kind: 'abandoned' } : { kind: 'held' };
    }
    if (!isPidAliveFn(holderPid))
        return { kind: 'abandoned', pid: holderPid };
    // A live pid does not prove a live holder: Windows quickly hands the pid of a
    // holder killed mid-migration to an unrelated process, and Fast Startup keeps
    // the kernel boot epoch across shutdowns, so no boot-time check can tell.
    // The heartbeat can: a live holder keeps refreshing the lock mtime, so a lock
    // that has stood still for staleMs is abandoned whatever its pid now names.
    return isLockFileOlderThan(lockFilePath, staleMs)
        ? { kind: 'abandoned', pid: holderPid }
        : { kind: 'held', pid: holderPid };
}
/**
 * At least three beats per stale window, at most one a minute. Synchronous
 * migration stretches (layout copy, schema migrations, integrity checks) block
 * the timer, so the shorter interval leaves them the most room before a live
 * holder reads as stale: about 14 minutes with the default 15-minute window.
 */
function heartbeatIntervalFor(staleMs) {
    return Math.max(1, Math.min(MAX_HEARTBEAT_INTERVAL_MS, Math.floor(staleMs / 3)));
}
/**
 * Breaks an abandoned lock without ever removing a live one. Checking and
 * deleting by path is not atomic: a waiter that judged the old lock abandoned
 * could otherwise delete the fresh lock another waiter created after breaking
 * it. Reclaimers therefore serialize on one exclusive guard and re-judge the
 * lock that is on disk *now* while holding it; an abandoned lock has no live
 * owner to release or replace it, so it cannot change under the guard.
 * (Comparing inode and mtime is no substitute: Linux reuses a freed inode
 * number at once and file mtimes are clock-tick coarse.) Returns true when
 * the caller should retry the exclusive create right away.
 */
function reclaimAbandonedLock(lockFilePath, staleMs, isPidAliveFn) {
    const guardPath = `${lockFilePath}${RECLAIM_GUARD_SUFFIX}`;
    let guardFd;
    try {
        guardFd = fs.openSync(guardPath, 'wx');
    }
    catch (error) {
        // Another waiter is reclaiming. A guard is held for microseconds, so an
        // old one belongs to a crashed reclaimer.
        if (hasCode(error, 'EEXIST') && isLockFileOlderThan(guardPath, RECLAIM_GUARD_STALE_MS)) {
            removeLockFile(guardPath);
        }
        return false;
    }
    try {
        const current = inspectLockHolder(lockFilePath, staleMs, isPidAliveFn);
        if (current.kind === 'gone')
            return true;
        return current.kind === 'abandoned' && removeLockFile(lockFilePath);
    }
    finally {
        closeQuietly(guardFd);
        removeLockFile(guardPath);
    }
}
function closeQuietly(fd) {
    try {
        fs.closeSync(fd);
    }
    catch {
        // Already closed.
    }
}
function parseHolderPid(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return undefined;
        const pid = parsed.pid;
        return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    }
    catch {
        return undefined;
    }
}
function isLockFileOlderThan(lockFilePath, staleMs) {
    try {
        return Date.now() - fs.statSync(lockFilePath).mtimeMs > staleMs;
    }
    catch {
        return false;
    }
}
/** POSIX and Windows: ESRCH means the pid is gone; EPERM means it exists but is protected. */
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return !hasCode(error, 'ESRCH');
    }
}
function removeLockFile(lockFilePath) {
    try {
        fs.rmSync(lockFilePath, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
function ensureManagedMigrationDirectory(v2Root, migrationDir) {
    fs.mkdirSync(v2Root, { recursive: true });
    ensureExistingPathNotSymlink(v2Root);
    fs.mkdirSync(migrationDir, { recursive: true });
    ensureExistingPathNotSymlink(migrationDir);
}
function ensureExistingPathNotSymlink(filePath) {
    try {
        if (fs.lstatSync(filePath).isSymbolicLink()) {
            throw new Error(`Unsafe migration lock symlink path: ${filePath}`);
        }
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
}
function hasCode(error, code) {
    return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === code);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=local-runtime-migration-lock.js.map