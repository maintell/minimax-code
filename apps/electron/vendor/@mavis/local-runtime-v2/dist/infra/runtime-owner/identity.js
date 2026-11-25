import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { settleInBackground } from '../async/settle.js';
import { readProcessStartToken } from './process-start-time.js';
import { parseRuntimeOwnerLease, serializeRuntimeOwnerLease } from './runtime-owner-lease.js';
const DEFAULT_RUNTIME_OWNER_STALE_MS = 10_000;
// Uptime has whole-second resolution and the wall clock may be stepped after boot, so only a
// heartbeat clearly older than this boot proves that its owner belonged to a previous boot.
const BOOT_TIME_TOLERANCE_MS = 5_000;
const OWNER_DIRECTORY = join('v2', 'runtime-owner-leases');
const OWNER_KINDS = new Set([
    'turn-lease',
    'session-delete',
    'queue-claim',
    'background-task',
]);
function formatRuntimeOwnerId(kind, pid, instanceId, operationId) {
    return `${kind}:${String(pid)}:${instanceId}.${operationId}`;
}
function createRuntimeOwnerLiveness(options) {
    return (ownerId) => {
        const parsed = parseOwnerId(ownerId);
        if (!parsed)
            return ownerId.startsWith('session-delete:') ? false : undefined;
        if (!parsed.instanceId)
            return options.isProcessAlive(parsed.pid);
        const leaseState = options.getInstanceLeaseState(parsed.instanceId);
        const currentInstance = parsed.pid === options.currentPid && parsed.instanceId === options.currentInstanceId;
        // Compromise revokes authority, but does not prove that this process finished draining.
        if (currentInstance)
            return leaseState !== 'missing';
        if (leaseState === 'missing')
            return false;
        if (!options.isProcessAlive(parsed.pid))
            return false;
        // A delayed heartbeat is not proof that this exact foreign owner died.
        // Its process must close the lease or exit before another Runtime may recover its work.
        // A stale lease left behind by a reboot or a hard kill may name a PID that another
        // process has since reused; that is proof of exit, not of a delayed heartbeat.
        if (leaseState === 'stale' && staleOwnerExited(options, parsed.instanceId, parsed.pid)) {
            return false;
        }
        return true;
    };
}
export async function createRuntimeOwnerIdentity(options) {
    const pid = options.pid ?? process.pid;
    const instanceId = options.instanceId ?? randomUUID();
    const staleMs = Math.max(2_000, Math.floor(options.staleMs ?? DEFAULT_RUNTIME_OWNER_STALE_MS));
    const ownerDirectory = join(options.dataDir, OWNER_DIRECTORY);
    const targetPath = ownerLeasePath(ownerDirectory, instanceId);
    await mkdir(ownerDirectory, { recursive: true });
    // The start token lets the generation fence tell this exact process apart from a later
    // process that reuses its PID. It is best-effort by design: `readProcessStartToken`
    // degrades to `undefined` instead of throwing, and a lease without a token is read back
    // as the historical PID-only lease rather than blocking the Runtime from starting.
    const readStartToken = options.readProcessStartToken ?? readProcessStartToken;
    const bootTimeMs = options.bootTimeMs ?? (() => Date.now() - uptime() * 1_000);
    const { token: startToken } = await readStartToken(pid);
    await writeFile(targetPath, serializeRuntimeOwnerLease({ pid, startToken }), {
        flag: 'wx',
        mode: 0o600,
    });
    const compromiseListeners = new Set();
    let compromise;
    let closed = false;
    let release;
    try {
        release = await lockfile.lock(targetPath, {
            realpath: false,
            stale: staleMs,
            update: Math.max(1_000, Math.floor(staleMs / 3)),
            onCompromised: (error) => markCompromised(error),
        });
    }
    catch (error) {
        await rm(targetPath, { force: true });
        throw error;
    }
    const isOwnerAlive = createRuntimeOwnerLiveness({
        currentPid: pid,
        currentInstanceId: instanceId,
        isProcessAlive: options.isProcessAlive ?? isProcessAlive,
        getInstanceLeaseState: (candidate) => {
            if (candidate === instanceId) {
                if (closed)
                    return 'missing';
                return compromise ? 'stale' : 'active';
            }
            if (!validInstanceId(candidate))
                return 'missing';
            const candidatePath = ownerLeasePath(ownerDirectory, candidate);
            try {
                statSync(candidatePath);
            }
            catch (error) {
                return errorCode(error) === 'ENOENT' ? 'missing' : 'stale';
            }
            try {
                return lockfile.checkSync(candidatePath, {
                    realpath: false,
                    stale: staleMs,
                })
                    ? 'active'
                    : 'stale';
            }
            catch {
                return 'stale';
            }
        },
        isOwnerFromPreviousBoot: (candidate) => heartbeatPredatesBoot(ownerLeasePath(ownerDirectory, candidate), bootTimeMs()),
        isOwnerProcessReplaced: createReplacedOwnerProbe(ownerDirectory, readStartToken),
    });
    let closePromise;
    function markCompromised(error) {
        if (closed || compromise)
            return;
        compromise = runtimeOwnerCompromiseError(error);
        for (const listener of compromiseListeners)
            notifyCompromise(listener, compromise);
    }
    return {
        instanceId,
        recoveryRetryMs: staleMs + 100,
        createOwnerId: (kind) => {
            assertOwnerIdentityActive(closed, compromise);
            return formatRuntimeOwnerId(kind, pid, instanceId, randomUUID());
        },
        ownsOwnerId: (ownerId) => !closed && !compromise && ownerMatchesRuntime(ownerId, pid, instanceId),
        isOwnerAlive,
        onCompromised: (listener) => {
            if (compromise) {
                notifyCompromise(listener, compromise);
                return () => undefined;
            }
            compromiseListeners.add(listener);
            return () => compromiseListeners.delete(listener);
        },
        close: () => {
            closePromise ??= (async () => {
                closed = true;
                compromiseListeners.clear();
                try {
                    await release?.();
                }
                catch {
                    // The exact owner is already marked closed; stale-lock cleanup may finish later.
                }
                await rm(targetPath, { force: true });
            })();
            return closePromise;
        },
    };
}
export function createProcessLocalRuntimeOwnerIdentity(options = {}) {
    const pid = options.pid ?? process.pid;
    const instanceId = options.instanceId ?? randomUUID();
    let closed = false;
    return {
        instanceId,
        recoveryRetryMs: DEFAULT_RUNTIME_OWNER_STALE_MS,
        createOwnerId: (kind) => {
            assertOwnerIdentityActive(closed);
            return formatRuntimeOwnerId(kind, pid, instanceId, randomUUID());
        },
        ownsOwnerId: (ownerId) => !closed && ownerMatchesRuntime(ownerId, pid, instanceId),
        isOwnerAlive: createRuntimeOwnerLiveness({
            currentPid: pid,
            currentInstanceId: instanceId,
            isProcessAlive,
            getInstanceLeaseState: (candidate) => candidate === instanceId && !closed ? 'active' : 'missing',
        }),
        onCompromised: () => () => undefined,
        close: async () => {
            closed = true;
            void closed;
        },
    };
}
function staleOwnerExited(options, instanceId, pid) {
    // The boot check is synchronous and works without a start-time probe (Windows, legacy
    // leases), so it decides the reboot case on the first observation.
    if (options.isOwnerFromPreviousBoot?.(instanceId))
        return true;
    return options.isOwnerProcessReplaced?.(instanceId, pid) === true;
}
/**
 * Reads the lock heartbeat, which proper-lockfile refreshes while the owner lives. A missing
 * lock directory proves nothing here, so it never reports a previous boot.
 */
function heartbeatPredatesBoot(leasePath, bootAtMs) {
    let heartbeatMs;
    try {
        heartbeatMs = statSync(`${leasePath}.lock`).mtimeMs;
    }
    catch {
        return false;
    }
    return heartbeatMs < bootAtMs - BOOT_TIME_TOLERANCE_MS;
}
/**
 * Compares a stale lease's recorded start token with the process that now holds its PID.
 *
 * `isOwnerAlive` runs inside synchronous DB transactions while the macOS probe spawns `ps`,
 * so the probe runs in the background and only a proven replacement is remembered; until then
 * the owner keeps the PID-only answer and the caller's recovery retry observes the verdict.
 * A legacy lease or an unavailable probe never proves replacement, matching the generation
 * fence's degrade rules.
 */
function createReplacedOwnerProbe(ownerDirectory, readStartToken) {
    const replaced = new Set();
    const probing = new Set();
    return (instanceId, pid) => {
        const key = `${instanceId}:${String(pid)}`;
        if (replaced.has(key))
            return true;
        if (probing.has(key))
            return false;
        const recorded = readRecordedStartToken(ownerLeasePath(ownerDirectory, instanceId), pid);
        if (recorded === undefined)
            return false;
        probing.add(key);
        settleInBackground((async () => {
            try {
                const probe = await readStartToken(pid);
                if (probe.token !== undefined && probe.token !== recorded)
                    replaced.add(key);
            }
            finally {
                probing.delete(key);
            }
        })());
        return false;
    };
}
function readRecordedStartToken(leasePath, pid) {
    let text;
    try {
        text = readFileSync(leasePath, 'utf8');
    }
    catch {
        return undefined;
    }
    const lease = parseRuntimeOwnerLease(text);
    return lease.format === 'structured' && lease.pid === pid ? lease.startToken : undefined;
}
function assertOwnerIdentityActive(closed, compromise) {
    if (compromise)
        throw compromise;
    if (closed)
        throw new Error('Runtime owner identity is closed');
}
function runtimeOwnerCompromiseError(cause) {
    const code = errorCode(cause) ?? 'ECOMPROMISED';
    return Object.assign(new Error('Runtime owner lease is compromised', { cause }), { code });
}
function notifyCompromise(listener, error) {
    try {
        listener(error);
    }
    catch {
        // One observer cannot prevent other owners from entering fail-closed shutdown.
    }
}
function errorCode(error) {
    if (!error || typeof error !== 'object' || !('code' in error))
        return undefined;
    const code = error.code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
}
function ownerMatchesRuntime(ownerId, pid, instanceId) {
    const parsed = parseOwnerId(ownerId);
    return parsed?.pid === pid && parsed.instanceId === instanceId;
}
function parseOwnerId(ownerId) {
    const match = /^([^:]+):([1-9]\d*):([^:]+)$/.exec(ownerId);
    if (!match)
        return undefined;
    const kind = match[1];
    if (!OWNER_KINDS.has(kind))
        return undefined;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid))
        return undefined;
    const token = match[3] ?? '';
    const separator = token.indexOf('.');
    if (separator < 1)
        return { kind, pid };
    const instanceId = token.slice(0, separator);
    return validInstanceId(instanceId) ? { kind, pid, instanceId } : undefined;
}
function ownerLeasePath(ownerDirectory, instanceId) {
    if (!validInstanceId(instanceId))
        throw new TypeError('Invalid Runtime owner instance id');
    return join(ownerDirectory, `${instanceId}.owner`);
}
function validInstanceId(value) {
    return /^[A-Za-z0-9-]+$/.test(value);
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error instanceof Error && 'code' in error && error.code === 'EPERM';
    }
}
//# sourceMappingURL=identity.js.map