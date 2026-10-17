import {} from 'node:fs';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';
import { logger } from '../logging/index.js';
import { readProcessStartToken } from './process-start-time.js';
import { codedError, errorCode, readOptionalText, } from './rootless-v2-generation-fs.js';
import { parseRuntimeOwnerLease } from './runtime-owner-lease.js';
const OWNERS_ACTIVE_ERROR_CODE = 'ROOTLESS_V2_OWNERS_ACTIVE';
const OWNER_LEASE_STALE_MS = 10_000;
export async function acquireGenerationOperationFence(paths) {
    await mkdir(dirname(paths.dataDir), { recursive: true });
    await writeFile(paths.lockTarget, '', { flag: 'a', mode: 0o600 });
    if (process.platform !== 'win32')
        await chmod(paths.lockTarget, 0o600);
    let compromised;
    const releaseLock = await lockfile.lock(paths.lockTarget, {
        realpath: false,
        stale: 300_000,
        update: 10_000,
        retries: { retries: 50, minTimeout: 20, maxTimeout: 200, factor: 1.2 },
        onCompromised: (error) => {
            compromised = error;
        },
    });
    let released = false;
    const assert = () => {
        if (compromised)
            throw compromised;
        if (released)
            throw new Error('Generation operation fence was released');
    };
    return {
        assert,
        release: async () => {
            if (released)
                return;
            released = true;
            try {
                await releaseLock();
            }
            catch {
                // A compromised operation fails at its exact publish fence.
            }
        },
    };
}
export async function withGenerationOperationLock(paths, operation) {
    const fence = await acquireGenerationOperationFence(paths);
    try {
        fence.assert();
        return await operation(fence.assert);
    }
    finally {
        await fence.release();
    }
}
/**
 * Fails closed while any Runtime still owns `dataDir` (ADR-005 decision 4).
 *
 * The scan never stops at the first live owner: dead leases are reclaimed first so the
 * `.owner` files a SIGKILLed Utility process leaves behind stay bounded, and only then is
 * the live owner reported. Reclaim is limited to leases proven dead — a lease whose
 * liveness cannot be established keeps the fence closed.
 */
export async function assertRuntimeOwnersStopped(dataDir, probes = {}) {
    const ownerDirectory = join(dataDir, 'v2', 'runtime-owner-leases');
    const entries = await readDirectoryIfPresent(ownerDirectory);
    const dead = [];
    let active;
    let indeterminate = 0;
    for (const entry of entries) {
        // Sibling `<instance>.owner.lock` directories live here too and are not leases.
        if (!entry.isFile() || !entry.name.endsWith('.owner'))
            continue;
        const verdict = await inspectLease(join(ownerDirectory, entry.name), entry.name, probes);
        if (verdict.state === 'dead')
            dead.push(verdict);
        else if (verdict.state === 'active')
            active ??= verdict;
        else {
            indeterminate += 1;
            logger.warn({ event: 'rootless_v2_owner_lease_indeterminate', ...leaseFields(verdict, dataDir) }, 'Rootless V2 Runtime owner lease could not be decided and was left in place');
        }
    }
    const reclaimed = await reclaimDeadLeases(dead, dataDir, probes);
    if (active) {
        logger.warn({ event: 'rootless_v2_owner_lease_active', ...leaseFields(active, dataDir) }, 'Rootless V2 Runtime owners are active');
        throw ownersActiveError(active, dataDir);
    }
    logger.info({
        event: 'rootless_v2_owner_lease_scan_clear',
        data_dir: dataDir,
        lease_count: dead.length + indeterminate,
        reclaimed_count: reclaimed,
        indeterminate_count: indeterminate,
    }, 'Rootless V2 Runtime owner scan found no active owner');
}
export function isOwnersActiveError(error) {
    return errorCode(error) === OWNERS_ACTIVE_ERROR_CODE;
}
/**
 * Reports the exact blocking lease in the message as well as in structured fields: the
 * Utility process can be SIGKILLed by the bootstrap watchdog before its log lines reach
 * disk, so the error text has to stand on its own for the UI and for support bundles.
 */
function ownersActiveError(verdict, dataDir) {
    const lockDetail = verdict.lockErrorCode ? ` lockErrorCode=${verdict.lockErrorCode}` : '';
    const message = `Rootless V2 Runtime owners are active (lease=${verdict.leaseFile} ` +
        `holderPid=${verdict.holderPid === undefined ? 'unknown' : String(verdict.holderPid)} ` +
        `reason=${verdict.reason}${lockDetail} dataDir=${dataDir})`;
    return Object.assign(codedError(OWNERS_ACTIVE_ERROR_CODE, message), {
        leaseFile: verdict.leaseFile,
        reason: verdict.reason,
        dataDir,
        ...(verdict.holderPid === undefined ? {} : { holderPid: verdict.holderPid }),
        ...(verdict.lockErrorCode === undefined ? {} : { lockErrorCode: verdict.lockErrorCode }),
    });
}
async function inspectLease(leasePath, leaseFile, probes) {
    const lease = parseRuntimeOwnerLease(await readOptionalText(leasePath));
    const base = {
        leaseFile,
        leasePath,
        leaseFormat: lease.format,
        ...('pid' in lease ? { holderPid: lease.pid } : {}),
        ...('recordIssue' in lease && lease.recordIssue !== undefined
            ? { leaseRecordIssue: lease.recordIssue }
            : {}),
    };
    const lock = await inspectLeaseLock(leasePath, probes);
    if (lock.state === 'held')
        return { ...base, state: 'active', reason: 'lock-held' };
    if (lock.state === 'error') {
        // Neither a released lease nor a permission problem can be told apart from a real
        // conflict here, so the fence stays closed and forwards the code to the caller.
        return {
            ...base,
            state: 'active',
            reason: 'lock-check-failed',
            lockErrorCode: lock.code ?? 'UNKNOWN',
        };
    }
    if (lease.format === 'absent')
        return { ...base, state: 'dead', reason: 'lease-absent' };
    if (lease.format === 'unreadable') {
        return { ...base, state: 'indeterminate', reason: 'unreadable-lease' };
    }
    return { ...base, ...(await inspectLeaseHolder(lease, probes)) };
}
async function inspectLeaseHolder(lease, probes) {
    const alive = (probes.isProcessAlive ?? isProcessAlive)(lease.pid);
    if (!alive)
        return { state: 'dead', reason: 'pid-dead', livenessBasis: 'pid-only' };
    if (lease.format === 'legacy') {
        // Pre-start-token lease: the PID alone is all the evidence there is, so this keeps
        // the historical fail-closed answer rather than guessing.
        return { state: 'active', reason: 'pid-alive', livenessBasis: 'pid-only' };
    }
    const probe = await (probes.readProcessStartToken ?? readProcessStartToken)(lease.pid);
    if (probe.token === undefined) {
        // No comparable token on this platform: degrade to the historical PID-only answer
        // instead of guessing, and record why the stronger check was skipped.
        return {
            state: 'active',
            reason: 'pid-alive',
            livenessBasis: 'pid-only',
            startTokenUnavailable: probe.unavailable ?? 'probe-unavailable',
        };
    }
    if (probe.token !== lease.startToken) {
        // Same PID, different process: the recorded owner exited and the number was reused.
        return { state: 'dead', reason: 'start-time-mismatch', livenessBasis: 'start-time' };
    }
    return { state: 'active', reason: 'pid-alive', livenessBasis: 'start-time' };
}
async function reclaimDeadLeases(dead, dataDir, probes) {
    let reclaimed = 0;
    for (const verdict of dead) {
        try {
            // The lock directory goes first: an orphan `.owner` is re-evaluated and reclaimed on
            // the next boot, whereas an orphan `.lock` would never be scanned again.
            await rm(`${verdict.leasePath}.lock`, { recursive: true, force: true });
            await (probes.removeLease ?? defaultRemoveLease)(verdict.leasePath);
            reclaimed += 1;
            logger.warn({ event: 'rootless_v2_owner_lease_reclaimed', ...leaseFields(verdict, dataDir) }, 'Reclaimed a dead Rootless V2 Runtime owner lease');
        }
        catch (error) {
            // Reclaim is opportunistic hygiene; a dead lease that cannot be deleted still does
            // not own the dataDir, so startup must continue.
            logger.warn({
                event: 'rootless_v2_owner_lease_reclaim_failed',
                ...leaseFields(verdict, dataDir),
                error_code: errorCode(error) ?? 'UNKNOWN',
            }, 'Failed to reclaim a dead Rootless V2 Runtime owner lease');
        }
    }
    return reclaimed;
}
function defaultRemoveLease(path) {
    return rm(path, { force: true });
}
function leaseFields(verdict, dataDir) {
    return {
        data_dir: dataDir,
        lease_file: verdict.leaseFile,
        lease_format: verdict.leaseFormat,
        lease_record_issue: verdict.leaseRecordIssue,
        holder_pid: verdict.holderPid,
        reason: verdict.reason,
        liveness_basis: verdict.livenessBasis,
        lock_error_code: verdict.lockErrorCode,
        start_token_unavailable: verdict.startTokenUnavailable,
    };
}
async function readDirectoryIfPresent(path) {
    try {
        return await readdir(path, { withFileTypes: true });
    }
    catch (error) {
        if (errorCode(error) === 'ENOENT')
            return [];
        throw error;
    }
}
async function inspectLeaseLock(path, probes) {
    try {
        const held = await (probes.checkLeaseLocked ?? defaultCheckLeaseLocked)(path);
        return { state: held ? 'held' : 'free' };
    }
    catch (error) {
        const code = errorCode(error);
        // A lease that disappeared between readdir and this probe was released by its owner
        // and cannot be holding the dataDir. Every other failure keeps the fence closed.
        if (code === 'ENOENT')
            return { state: 'free', code };
        return { state: 'error', code: code ?? 'UNKNOWN' };
    }
}
function defaultCheckLeaseLocked(path) {
    return lockfile.check(path, { realpath: false, stale: OWNER_LEASE_STALE_MS });
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        // EPERM means the PID exists but belongs to another user, which on its own cannot be
        // told apart from a live owner. Only the start-token comparison can resolve that, so
        // without one this stays fail-closed.
        return errorCode(error) === 'EPERM';
    }
}
//# sourceMappingURL=rootless-v2-generation-fence.js.map