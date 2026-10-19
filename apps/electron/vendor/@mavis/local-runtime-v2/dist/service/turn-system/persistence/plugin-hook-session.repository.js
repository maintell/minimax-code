import { and, desc, eq } from 'drizzle-orm';
import { turnIngress } from '../../../infra/db/schema/turn.js';
/** Owns the durable Plugin Hook Session ownership and SessionEnd claim protocol. */
export function createPluginHookSessionPersistence(db, nowMs) {
    return {
        preparePluginHookSessionOwnership: (input) => preparePluginHookSessionOwnership(db, input, nowMs()),
        activatePluginHookSessionOwnership: (input) => activatePluginHookSessionOwnership(db, input, nowMs()),
        findLatestPluginHookSessionOwnership: async (sessionId) => {
            const owned = db.transaction((tx) => findLatestPluginHookSessionOwner(tx, sessionId));
            return owned
                ? {
                    ownershipClaimId: owned.hookSession.ownership.claimId,
                    turnId: owned.turnId,
                    claimedAtMs: owned.hookSession.ownership.claimedAtMs,
                }
                : undefined;
        },
        tryClaimPluginHookSessionEnd: (input) => tryClaimPluginHookSessionEnd(db, input, nowMs()),
        completePluginHookSessionEnd: (input) => completePluginHookSessionEnd(db, input, nowMs()),
    };
}
async function preparePluginHookSessionOwnership(db, input, claimedAtMs) {
    return db.transaction((tx) => {
        const row = tx
            .select({
            turnId: turnIngress.turnId,
            busyReason: turnIngress.busyReason,
            inputMetadataJson: turnIngress.inputMetadataJson,
        })
            .from(turnIngress)
            .where(and(eq(turnIngress.sessionId, input.sessionId), eq(turnIngress.turnId, input.turnId)))
            .get();
        if (!row || row.busyReason !== 'turn') {
            throw new Error(`Cannot claim Plugin Hook ownership for Turn: ${input.turnId}`);
        }
        const metadata = parseInputMetadata(row.inputMetadataJson);
        const existing = parsePluginHookSessionMetadata(metadata.pluginHookSession, input.turnId);
        if (existing) {
            if (existing.ownership.claimId !== input.ownershipClaimId) {
                throw new Error(`Plugin Hook ownership already prepared for Turn: ${input.turnId}`);
            }
            // Retrying either phase with the same durable claim is safe and must
            // never downgrade an already activated owner back to prepared.
            return;
        }
        tx.update(turnIngress)
            .set({
            inputMetadataJson: JSON.stringify({
                ...metadata,
                pluginHookSession: {
                    ownership: {
                        claimId: input.ownershipClaimId,
                        turnId: input.turnId,
                        claimedAtMs,
                        phase: 'prepared',
                    },
                },
            }),
        })
            .where(and(eq(turnIngress.sessionId, input.sessionId), eq(turnIngress.turnId, input.turnId)))
            .run();
    }, { behavior: 'immediate' });
}
async function activatePluginHookSessionOwnership(db, input, activatedAtMs) {
    return db.transaction((tx) => {
        const row = tx
            .select({ inputMetadataJson: turnIngress.inputMetadataJson })
            .from(turnIngress)
            .where(and(eq(turnIngress.sessionId, input.sessionId), eq(turnIngress.turnId, input.turnId)))
            .get();
        const metadata = parseInputMetadata(row?.inputMetadataJson ?? '{}');
        const hookSession = parsePluginHookSessionMetadata(metadata.pluginHookSession, input.turnId);
        if (!hookSession || hookSession.ownership.claimId !== input.ownershipClaimId) {
            throw new Error(`Cannot activate Plugin Hook ownership for Turn: ${input.turnId}`);
        }
        if (hookSession.ownership.phase === 'activated')
            return;
        tx.update(turnIngress)
            .set({
            inputMetadataJson: JSON.stringify({
                ...metadata,
                pluginHookSession: {
                    ...hookSession,
                    ownership: {
                        ...hookSession.ownership,
                        phase: 'activated',
                        activatedAtMs,
                    },
                },
            }),
        })
            .where(and(eq(turnIngress.sessionId, input.sessionId), eq(turnIngress.turnId, input.turnId)))
            .run();
    }, { behavior: 'immediate' });
}
async function tryClaimPluginHookSessionEnd(db, input, claimedAtMs) {
    return db.transaction((tx) => {
        const latest = findLatestPluginHookSessionOwner(tx, input.sessionId);
        if (!latest || latest.hookSession.ownership.claimId !== input.ownershipClaimId) {
            return { status: 'superseded' };
        }
        if (latest.hookSession.sessionEnd)
            return { status: 'already-claimed' };
        tx.update(turnIngress)
            .set({
            inputMetadataJson: JSON.stringify({
                ...latest.metadata,
                pluginHookSession: {
                    ...latest.hookSession,
                    sessionEnd: {
                        claimId: input.sessionEndClaimId,
                        reason: input.reason,
                        claimedAtMs,
                    },
                },
            }),
        })
            .where(eq(turnIngress.turnId, latest.turnId))
            .run();
        return { status: 'claimed' };
    }, { behavior: 'immediate' });
}
async function completePluginHookSessionEnd(db, input, completedAtMs) {
    return db.transaction((tx) => {
        const owned = findPluginHookSessionOwner(tx, input.sessionId, input.ownershipClaimId);
        if (!owned || owned.hookSession.sessionEnd?.claimId !== input.sessionEndClaimId)
            return false;
        tx.update(turnIngress)
            .set({
            inputMetadataJson: JSON.stringify({
                ...owned.metadata,
                pluginHookSession: {
                    ...owned.hookSession,
                    sessionEnd: { ...owned.hookSession.sessionEnd, completedAtMs },
                },
            }),
        })
            .where(eq(turnIngress.turnId, owned.turnId))
            .run();
        return true;
    }, { behavior: 'immediate' });
}
function findLatestPluginHookSessionOwner(tx, sessionId) {
    return findPluginHookSessionOwner(tx, sessionId);
}
function findPluginHookSessionOwner(tx, sessionId, ownershipClaimId) {
    const rows = tx
        .select({ turnId: turnIngress.turnId, inputMetadataJson: turnIngress.inputMetadataJson })
        .from(turnIngress)
        .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.busyReason, 'turn')))
        .orderBy(desc(turnIngress.acceptedSequence))
        .all();
    for (const row of rows) {
        const metadata = parseInputMetadata(row.inputMetadataJson);
        const hookSession = parsePluginHookSessionMetadata(metadata.pluginHookSession, row.turnId);
        if (!hookSession)
            continue;
        if (hookSession.ownership.phase !== 'activated')
            continue;
        if (ownershipClaimId && hookSession.ownership.claimId !== ownershipClaimId)
            continue;
        return { turnId: row.turnId, metadata, hookSession };
    }
    return undefined;
}
function parseInputMetadata(value) {
    try {
        const parsed = JSON.parse(value);
        return isPlainRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function parsePluginHookSessionMetadata(value, rowTurnId) {
    if (!isPlainRecord(value))
        return undefined;
    const ownership = parsePluginHookSessionOwnership(value.ownership, rowTurnId);
    if (!ownership)
        return undefined;
    const sessionEnd = parseOptionalPluginHookSessionEnd(value.sessionEnd);
    if (!sessionEnd.valid)
        return undefined;
    return {
        ownership,
        ...(sessionEnd.value ? { sessionEnd: sessionEnd.value } : {}),
    };
}
function parsePluginHookSessionOwnership(value, rowTurnId) {
    if (!isPlainRecord(value))
        return undefined;
    const ownership = value;
    const claimId = ownership.claimId;
    const turnId = ownership.turnId;
    const claimedAtMs = ownership.claimedAtMs;
    const activatedAtMs = ownership.activatedAtMs;
    if (!isBoundedString(claimId))
        return undefined;
    if (turnId !== rowTurnId)
        return undefined;
    if (!isFiniteTimestamp(claimedAtMs))
        return undefined;
    const phase = parsePluginHookSessionOwnershipPhase(ownership.phase, activatedAtMs);
    if (!phase)
        return undefined;
    return {
        claimId,
        turnId,
        claimedAtMs,
        ...phase,
    };
}
function parsePluginHookSessionOwnershipPhase(value, activatedAtMs) {
    if (value === 'prepared')
        return activatedAtMs === undefined ? { phase: value } : undefined;
    if (value !== 'activated' || !isFiniteTimestamp(activatedAtMs))
        return undefined;
    return { phase: value, activatedAtMs };
}
function parseOptionalPluginHookSessionEnd(value) {
    if (value === undefined)
        return { valid: true };
    if (!isValidPluginHookSessionEnd(value))
        return { valid: false };
    return {
        valid: true,
        value: {
            claimId: value.claimId,
            reason: value.reason,
            claimedAtMs: value.claimedAtMs,
            ...(value.completedAtMs !== undefined ? { completedAtMs: value.completedAtMs } : {}),
        },
    };
}
function isValidPluginHookSessionEnd(value) {
    if (!isPlainRecord(value))
        return false;
    return (isBoundedString(value.claimId) &&
        isPluginHookSessionEndReason(value.reason) &&
        isFiniteTimestamp(value.claimedAtMs) &&
        (value.completedAtMs === undefined || isFiniteTimestamp(value.completedAtMs)));
}
function isPluginHookSessionEndReason(value) {
    return (value === 'archive' ||
        value === 'clear' ||
        value === 'logout' ||
        value === 'resume_other' ||
        value === 'idle_timeout');
}
function isPlainRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isBoundedString(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 512;
}
function isFiniteTimestamp(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
//# sourceMappingURL=plugin-hook-session.repository.js.map