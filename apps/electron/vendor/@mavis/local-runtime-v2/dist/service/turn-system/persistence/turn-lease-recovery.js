import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import { sessionLocks, turnIngress } from '../../../infra/db/schema/turn.js';
const LEGACY_TURN_LEASE_STALL_MS = 30_000;
const LEGACY_TURN_LEASE_OWNER_ID = /^turn-lease:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function shouldRecoverStalledLegacyTurnLease(observations, observedLeases, candidate) {
    if (!LEGACY_TURN_LEASE_OWNER_ID.test(candidate.ownerId))
        return false;
    const key = [
        candidate.sessionId,
        candidate.ownerId,
        candidate.ownerKind,
        String(candidate.acquiredAtMs),
    ].join('\u0000');
    observedLeases.add(key);
    const previous = observations.get(key);
    if (!previous ||
        previous.expiresAtMs !== candidate.expiresAtMs ||
        candidate.observedAtMs < previous.unchangedSinceMs) {
        observations.set(key, {
            expiresAtMs: candidate.expiresAtMs,
            unchangedSinceMs: candidate.observedAtMs,
        });
        return false;
    }
    if (candidate.observedAtMs - previous.unchangedSinceMs < LEGACY_TURN_LEASE_STALL_MS) {
        return false;
    }
    observations.delete(key);
    return true;
}
export const SESSION_DELETION_OWNER_KIND = 'session-deletion';
export const MAINTENANCE_OWNER_KIND = 'maintenance';
export const MAINTENANCE_DELETING_OWNER_KIND = 'maintenance-deleting';
export const TURN_DELETING_OWNER_KIND = 'turn-deleting';
export const COMPACTION_DELETING_OWNER_KIND = 'compaction-deleting';
export const DELETION_FENCE_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
const PROCESS_RESTART_OWNER_KINDS = [
    'turn',
    'compaction',
    'send',
    'dispatcher',
    MAINTENANCE_OWNER_KIND,
    TURN_DELETING_OWNER_KIND,
    COMPACTION_DELETING_OWNER_KIND,
    MAINTENANCE_DELETING_OWNER_KIND,
    SESSION_DELETION_OWNER_KIND,
];
export function recoverExpiredInTransaction(tx, sessionId, nowMs) {
    const expired = tx
        .select()
        .from(sessionLocks)
        .where(and(eq(sessionLocks.sessionId, sessionId), lte(sessionLocks.expiresAtMs, nowMs)))
        .get();
    if (!expired)
        return { released: false, terminalFacts: [] };
    return releaseRecoveredLockInTransaction(tx, expired, nowMs, 'expired-lease');
}
export function recoverDeadLegacyOwnerInTransaction(tx, sessionId, nowMs) {
    const lock = findSessionLock(tx, sessionId);
    if (!lock || legacyProcessOwnerAlive(lock) !== false) {
        return { released: false, terminalFacts: [] };
    }
    return releaseRecoveredLockInTransaction(tx, lock, nowMs, 'process-restart');
}
export function recoverProcessRestartInTransaction(tx, input) {
    const { completedAtMs, isLeaseOwnerAlive, makeDeletionOwnerId, shouldRecoverLegacyTurnLease } = input;
    const orphanedLocks = findRecoverableLocks(tx, input);
    const recovered = [];
    const liveSessionIds = [];
    const pendingDeletionSessionIds = [];
    for (const lock of orphanedLocks) {
        const ownerAlive = isLeaseOwnerAlive(lock.ownerId);
        const recoverStalledLegacyLease = ownerAlive === undefined &&
            lock.expiresAtMs > completedAtMs &&
            shouldRecoverLegacyTurnLease?.({
                sessionId: lock.sessionId,
                ownerId: lock.ownerId,
                ownerKind: lock.ownerKind,
                acquiredAtMs: lock.acquiredAtMs,
                expiresAtMs: lock.expiresAtMs,
                observedAtMs: completedAtMs,
            }) === true;
        if (ownerAlive === true ||
            (ownerAlive === undefined && lock.expiresAtMs > completedAtMs && !recoverStalledLegacyLease)) {
            liveSessionIds.push(lock.sessionId);
            continue;
        }
        if (lock.ownerKind === SESSION_DELETION_OWNER_KIND) {
            const reclaimed = tx
                .update(sessionLocks)
                .set({
                ownerId: makeDeletionOwnerId(),
                acquiredAtMs: completedAtMs,
                expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
            })
                .where(and(eq(sessionLocks.sessionId, lock.sessionId), eq(sessionLocks.ownerId, lock.ownerId), eq(sessionLocks.ownerKind, lock.ownerKind), eq(sessionLocks.acquiredAtMs, lock.acquiredAtMs)))
                .run();
            if (reclaimed.changes !== 1) {
                throw new Error(`Session deletion recovery lost ownership: ${lock.sessionId}`);
            }
            pendingDeletionSessionIds.push(lock.sessionId);
            continue;
        }
        recovered.push(recoverProcessRestartLockInTransaction(tx, lock, completedAtMs));
    }
    return {
        recovered,
        liveSessionIds,
        pendingDeletionSessionIds,
        terminalFacts: recovered.flatMap((entry) => entry.turnId
            ? [
                createRecoveredTerminalFact(entry.sessionId, entry.turnId, completedAtMs, 'process-restart'),
            ]
            : []),
    };
}
function findRecoverableLocks(tx, input) {
    if (!input.sessionIds) {
        return tx
            .select()
            .from(sessionLocks)
            .where(and(inArray(sessionLocks.ownerKind, [...PROCESS_RESTART_OWNER_KINDS]), lt(sessionLocks.acquiredAtMs, input.processStartedAtMs)))
            .orderBy(asc(sessionLocks.sessionId))
            .all();
    }
    const sessionIdGroups = groupedSessionIds(input.sessionIds);
    return sessionIdGroups
        .flatMap((sessionIdGroup) => tx
        .select()
        .from(sessionLocks)
        .where(and(inArray(sessionLocks.ownerKind, [...PROCESS_RESTART_OWNER_KINDS]), lt(sessionLocks.acquiredAtMs, input.processStartedAtMs), ...(sessionIdGroup ? [inArray(sessionLocks.sessionId, sessionIdGroup)] : [])))
        .orderBy(asc(sessionLocks.sessionId))
        .all())
        .sort(compareSessionIds);
}
function groupedSessionIds(sessionIds) {
    if (!sessionIds)
        return [undefined];
    const uniqueSessionIds = [...new Set(sessionIds)].sort(compareSessionId);
    if (uniqueSessionIds.length === 0)
        return [];
    const groups = [];
    for (let start = 0; start < uniqueSessionIds.length; start += 500) {
        groups.push(uniqueSessionIds.slice(start, start + 500));
    }
    return groups;
}
function compareSessionIds(left, right) {
    return compareSessionId(left.sessionId, right.sessionId);
}
function compareSessionId(left, right) {
    if (left === right)
        return 0;
    return left < right ? -1 : 1;
}
export function createRecoveredTerminalFact(sessionId, turnId, completedAtMs, reason) {
    return {
        sessionId,
        turnId,
        completedAtMs,
        outcome: 'failed',
        reason,
    };
}
function releaseRecoveredLockInTransaction(tx, lock, completedAtMs, reason) {
    const orphan = tx
        .select({ turnId: turnIngress.turnId })
        .from(turnIngress)
        .where(and(eq(turnIngress.sessionId, lock.sessionId), eq(turnIngress.status, 'accepted')))
        .orderBy(desc(turnIngress.acceptedSequence))
        .get();
    const terminalFacts = orphan
        ? [createRecoveredTerminalFact(lock.sessionId, orphan.turnId, completedAtMs, reason)]
        : [];
    if (orphan) {
        tx.update(turnIngress)
            .set({ status: 'failed', completedAtMs })
            .where(eq(turnIngress.turnId, orphan.turnId))
            .run();
    }
    tx.delete(sessionLocks)
        .where(and(eq(sessionLocks.sessionId, lock.sessionId), eq(sessionLocks.ownerId, lock.ownerId), eq(sessionLocks.ownerKind, lock.ownerKind)))
        .run();
    return { released: true, terminalFacts };
}
function legacyProcessOwnerAlive(lock) {
    const match = /^(electron|cli|runtime):([1-9]\d*):.+$/.exec(lock.ownerId);
    if (!match || match[1] !== lock.ownerKind)
        return undefined;
    const pid = Number(match[2]);
    if (!Number.isSafeInteger(pid))
        return undefined;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        if (!(error instanceof Error) || !('code' in error))
            return undefined;
        if (error.code === 'EPERM')
            return true;
        return error.code === 'ESRCH' ? false : undefined;
    }
}
function findSessionLock(tx, sessionId) {
    return tx.select().from(sessionLocks).where(eq(sessionLocks.sessionId, sessionId)).get();
}
function recoverProcessRestartLockInTransaction(tx, lock, completedAtMs) {
    const ownerKind = lock.ownerKind;
    const turnId = isTurnOwnerKind(ownerKind)
        ? failLatestAcceptedTurnInTransaction(tx, lock.sessionId, completedAtMs)
        : undefined;
    const released = tx
        .delete(sessionLocks)
        .where(and(eq(sessionLocks.sessionId, lock.sessionId), eq(sessionLocks.ownerId, lock.ownerId), eq(sessionLocks.ownerKind, lock.ownerKind), eq(sessionLocks.acquiredAtMs, lock.acquiredAtMs)))
        .run();
    if (released.changes !== 1) {
        throw new Error(`Process restart recovery lost ownership: ${lock.sessionId}/${lock.ownerId}`);
    }
    return restartRecoveryEntry(lock.sessionId, ownerKind, turnId);
}
function failLatestAcceptedTurnInTransaction(tx, sessionId, completedAtMs) {
    const orphan = tx
        .select({ turnId: turnIngress.turnId })
        .from(turnIngress)
        .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
        .orderBy(desc(turnIngress.acceptedSequence))
        .get();
    if (!orphan)
        return undefined;
    const updated = tx
        .update(turnIngress)
        .set({ status: 'failed', completedAtMs })
        .where(and(eq(turnIngress.turnId, orphan.turnId), eq(turnIngress.status, 'accepted')))
        .run();
    if (updated.changes !== 1) {
        throw new Error(`Process restart Turn recovery lost ownership: ${sessionId}/${orphan.turnId}`);
    }
    return orphan.turnId;
}
function restartRecoveryEntry(sessionId, ownerKind, turnId) {
    return {
        sessionId,
        ownerKind,
        ...(turnId ? { turnId } : {}),
        disposition: 'released',
    };
}
function isTurnOwnerKind(ownerKind) {
    return (ownerKind === 'turn' ||
        ownerKind === 'compaction' ||
        ownerKind === 'send' ||
        ownerKind === 'dispatcher' ||
        isDeletingTurnOwnerKind(ownerKind));
}
function isDeletingTurnOwnerKind(ownerKind) {
    return ownerKind === TURN_DELETING_OWNER_KIND || ownerKind === COMPACTION_DELETING_OWNER_KIND;
}
//# sourceMappingURL=turn-lease-recovery.js.map