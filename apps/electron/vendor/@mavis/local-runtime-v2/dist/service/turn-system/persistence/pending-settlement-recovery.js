import { and, eq } from 'drizzle-orm';
import { sessionLocks, turnIngress } from '../../../infra/db/schema/turn.js';
import { COMPACTION_DELETING_OWNER_KIND, createRecoveredTerminalFact, DELETION_FENCE_EXPIRES_AT_MS, SESSION_DELETION_OWNER_KIND, TURN_DELETING_OWNER_KIND, } from './turn-lease-recovery.js';
export function pendingSettlementOf(input) {
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        leaseId: input.leaseId,
        ...(input.queuePauseCause ? { queuePauseCause: input.queuePauseCause } : {}),
    };
}
export function samePendingSettlement(left, right) {
    return (left?.sessionId === right.sessionId &&
        left.turnId === right.turnId &&
        left.leaseId === right.leaseId);
}
/**
 * Admission-path recovery: fails the exact pending Turn and, in the same
 * transaction, applies the Queue pause its failed settlement would have
 * committed, so the admission's own priority fence already observes it.
 * Session deletion uses {@link recoverPendingSettlementInTransaction} alone.
 */
export function recoverAdmissionPendingSettlementInTransaction(tx, priorityFence, pending, completedAtMs) {
    const terminalFact = recoverPendingSettlementInTransaction(tx, pending, completedAtMs);
    if (!terminalFact)
        return { queueFacts: [] };
    return {
        terminalFact,
        queueFacts: pending.queuePauseCause
            ? priorityFence.settledInTransaction(tx, {
                sessionId: pending.sessionId,
                triggerTurnId: pending.turnId,
                cause: pending.queuePauseCause,
                pausedAtMs: completedAtMs,
            })
            : [],
    };
}
export function recoverPendingSettlementInTransaction(tx, pending, completedAtMs) {
    const lock = tx
        .select({ ownerId: sessionLocks.ownerId, ownerKind: sessionLocks.ownerKind })
        .from(sessionLocks)
        .where(eq(sessionLocks.sessionId, pending.sessionId))
        .get();
    const receipt = tx
        .select({ status: turnIngress.status })
        .from(turnIngress)
        .where(and(eq(turnIngress.sessionId, pending.sessionId), eq(turnIngress.turnId, pending.turnId)))
        .get();
    if (lock?.ownerId !== pending.leaseId || receipt?.status !== 'accepted')
        return undefined;
    tx.update(turnIngress)
        .set({ status: 'failed', completedAtMs })
        .where(and(eq(turnIngress.sessionId, pending.sessionId), eq(turnIngress.turnId, pending.turnId), eq(turnIngress.status, 'accepted')))
        .run();
    releaseOrPromoteDeletionFence(tx, {
        sessionId: pending.sessionId,
        leaseId: pending.leaseId,
        ownerKind: lock.ownerKind,
        completedAtMs,
    });
    return createRecoveredTerminalFact(pending.sessionId, pending.turnId, completedAtMs, 'settlement-retry');
}
/** Releases a settled Turn lock, or hands a deletion-pending one to Session deletion. */
export function releaseOrPromoteDeletionFence(tx, input) {
    const ownership = and(eq(sessionLocks.sessionId, input.sessionId), eq(sessionLocks.ownerId, input.leaseId));
    if (input.ownerKind === TURN_DELETING_OWNER_KIND ||
        input.ownerKind === COMPACTION_DELETING_OWNER_KIND) {
        return tx
            .update(sessionLocks)
            .set({
            ownerKind: SESSION_DELETION_OWNER_KIND,
            acquiredAtMs: input.completedAtMs,
            expiresAtMs: DELETION_FENCE_EXPIRES_AT_MS,
        })
            .where(ownership)
            .run();
    }
    return tx.delete(sessionLocks).where(ownership).run();
}
//# sourceMappingURL=pending-settlement-recovery.js.map