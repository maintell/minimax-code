import { planSettleTurnTail as planSharedSettleTurnTail, } from '@mavis/harness';
import { canonicalActiveHistoryRevision, inspectCanonicalHistorySequence, } from '../../../sessions/representation/canonical-history-contract.js';
import { sanitizePtcSafetyHistoryMessage } from '../../ptc/safety-reconcile.js';
import { canonicalHistoryRecordEntry, } from './canonical-history-scanner.js';
/** Settlement follows the canonical sequence inspection; safety folds use the PTC sanitizer. */
const TURN_TAIL_RULES = {
    isSettled: (records) => inspectCanonicalHistorySequence(records).status ===
        'settled',
    sanitizeSafetyMessage: (message) => sanitizePtcSafetyHistoryMessage(message),
};
/** Plans the abort/network/safety/reply tail fold against the latest envelopes. */
export function planSettleTurnTail(active, input) {
    return planSharedSettleTurnTail(active, input, TURN_TAIL_RULES);
}
/**
 * The artifact holding the target Turn's first record: a snapshot index, `snapshots.length`
 * for the active history, or -1 when the Turn is absent.
 */
export function retractTurnArtifactIndex(history, turnId) {
    return retractArtifacts(history).findIndex(({ entries }) => entries.some((entry) => entry.turnId === turnId));
}
/**
 * Plans a target-Turn suffix removal across the reachable compaction lineage. When the Turn
 * starts in a snapshot, `targetSnapshotRecords` must hold that snapshot's records.
 */
export function planRetractTurn(history, input, targetSnapshotRecords) {
    validateRetractTurnInput(input);
    const artifacts = retractArtifacts(history);
    const artifactIndex = retractTurnArtifactIndex(history, input.turnId);
    if (artifactIndex < 0) {
        if (containsCompactionMarker(artifacts, input.turnId)) {
            throw new Error('Retracted Turn source boundary is missing from canonical history');
        }
        return {
            status: 'already-retracted',
            generation: history.activeGeneration,
            active: history.active,
            snapshots: history.snapshots,
            deletedMessageIds: [],
        };
    }
    const target = artifacts[artifactIndex];
    if (!target)
        throw new Error('Retracted Turn source boundary is missing from canonical history');
    const records = artifactIndex === history.snapshots.length ? history.active : targetSnapshotRecords;
    if (!records)
        throw new Error('Retracted Turn snapshot records were not loaded');
    const firstTargetIndex = records.findIndex(({ turn_id }) => turn_id === input.turnId);
    const targetSuffix = records.slice(firstTargetIndex);
    if (targetSuffix.some(({ turn_id }) => turn_id !== input.turnId)) {
        throw new Error('Retracted Turn is not the canonical history tail');
    }
    const active = records.slice(0, firstTargetIndex);
    assertTargetIsCurrentTail(history.active, input.turnId, active);
    assertSettled(active, 'Turn retraction prefix');
    if (target.generation > 0 && active.length === 0) {
        throw new Error('Turn retraction cannot preserve a non-zero generation without its marker');
    }
    return {
        status: 'committed',
        generation: target.generation,
        active,
        snapshots: history.snapshots.slice(0, Math.min(artifactIndex, history.snapshots.length)),
        deletedMessageIds: deletedTurnMessageIds(artifacts.slice(artifactIndex).flatMap(({ entries }) => entries), input.turnId, active),
    };
}
function retractArtifacts(history) {
    return [
        ...history.snapshots.map(({ generation, entries }) => ({ generation, entries })),
        {
            generation: history.activeGeneration,
            entries: history.active.map(canonicalHistoryRecordEntry),
        },
    ];
}
/**
 * Local copy of the harness validator, used only by {@link planRetractTurn} below. The shared
 * one is `@mavis/harness`'s `validateRetractTurnInput`, which `session-history-mutation-adapter`
 * calls; this file keeps THEIRS' own retract planner, so it needs its own `RetractTurnInput`
 * shape. Not exported: nothing outside this file reads it.
 */
function validateRetractTurnInput(input) {
    assertMutationIdentity(input);
    assertRetractReason(input.reason);
}
export function toTurnHistoryMutationCommit(input) {
    return {
        status: input.status,
        revision: canonicalActiveHistoryRevision(input.active),
        generation: input.generation,
        messages: Object.freeze(input.active.map(({ message }) => message)),
        identityVector: input.active.map(({ message_id }) => message_id),
        deletedMessageIds: [...input.deletedMessageIds],
    };
}
function assertMutationIdentity(input) {
    if (!input.sessionId.trim() || !input.turnId.trim() || !input.operationId.trim()) {
        throw new TypeError('Turn history mutation identity is required');
    }
}
function assertRetractReason(reason) {
    if (reason.kind === 'output-attempt-recall' &&
        (!Number.isSafeInteger(reason.attempt) || reason.attempt < 1)) {
        throw new TypeError('Output recall attempt must be a positive safe integer');
    }
}
function containsCompactionMarker(artifacts, turnId) {
    const markerTurnId = `${turnId}:compaction`;
    return artifacts.some(({ entries }) => entries.some((entry) => entry.turnId === markerTurnId));
}
/**
 * No later Turn follows the target in the active history. A compaction in the
 * target Turn, including a segment commit at its start, writes its records
 * under `<turnId>:compaction` and carries earlier records over verbatim; those
 * carried records stay after the retraction and do not end the Turn's tail.
 */
function assertTargetIsCurrentTail(active, turnId, retained) {
    const markerTurnId = `${turnId}:compaction`;
    const retainedIds = new Set(retained.map(({ message_id }) => message_id));
    const boundary = active.findIndex(({ turn_id }) => turn_id === turnId || turn_id === markerTurnId);
    if (boundary < 0 ||
        active
            .slice(boundary)
            .some(({ turn_id, message_id }) => turn_id !== turnId && turn_id !== markerTurnId && !retainedIds.has(message_id))) {
        throw new Error('Retracted Turn is not the canonical history tail');
    }
}
/** The Turn's own records; a compaction record the retraction keeps is not deleted. */
function deletedTurnMessageIds(entries, turnId, retained) {
    const markerTurnId = `${turnId}:compaction`;
    const retainedIds = new Set(retained.map(({ message_id }) => message_id));
    return [
        ...new Set(entries
            .filter((entry) => (entry.turnId === turnId || entry.turnId === markerTurnId) &&
            !retainedIds.has(entry.messageId))
            .map((entry) => entry.messageId)),
    ];
}
function assertSettled(records, operation) {
    if (inspectCanonicalHistorySequence(records).status !== 'settled') {
        throw new Error(`${operation} must produce settled canonical history`);
    }
}
//# sourceMappingURL=session-turn-history-mutation.js.map