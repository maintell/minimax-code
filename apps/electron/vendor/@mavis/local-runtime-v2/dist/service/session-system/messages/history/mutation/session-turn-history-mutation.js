import { canonicalActiveHistoryRevision, inspectCanonicalHistorySequence, } from '../../../sessions/representation/canonical-history-contract.js';
/** Plans the existing abort/network tail fold against the latest envelopes. */
export function planSettleTurnTail(active, input) {
    assertMutationIdentity(input);
    const last = active.at(-1);
    if (!last || last.turn_id !== input.turnId || last.message.role !== 'assistant') {
        return unchangedSettle(active);
    }
    if (input.mode === 'abort' && containsToolCall(last.message.content)) {
        return unchangedSettle(active);
    }
    const next = [...active];
    const approvedContent = input.approvedContent;
    const deletedMessageIds = [];
    if (!approvedContent.trim()) {
        next.pop();
        deletedMessageIds.push(last.message_id);
    }
    else {
        next[next.length - 1] = {
            ...last,
            message: {
                ...last.message,
                content: [{ type: 'text', text: approvedContent }],
            },
        };
    }
    if (sameJson(active, next))
        return unchangedSettle(active);
    assertSettled(next, 'Turn tail settlement');
    return { status: 'committed', active: next, deletedMessageIds };
}
/** Plans a target-Turn suffix removal across the reachable compaction lineage. */
export function planRetractTurn(history, input) {
    validateRetractTurnInput(input);
    const artifacts = [
        ...history.snapshots.map((snapshot) => ({
            generation: snapshot.generation,
            records: snapshot.records,
            snapshot,
        })),
        { generation: history.activeGeneration, records: history.active },
    ];
    const artifactIndex = artifacts.findIndex(({ records }) => records.some(({ turn_id }) => turn_id === input.turnId));
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
    assertTargetIsCurrentTail(history.active, input.turnId);
    const target = artifacts[artifactIndex];
    if (!target)
        throw new Error('Retracted Turn source boundary is missing from canonical history');
    const firstTargetIndex = target.records.findIndex(({ turn_id }) => turn_id === input.turnId);
    const targetSuffix = target.records.slice(firstTargetIndex);
    if (targetSuffix.some(({ turn_id }) => turn_id !== input.turnId)) {
        throw new Error('Retracted Turn is not the canonical history tail');
    }
    const active = target.records.slice(0, firstTargetIndex);
    assertSettled(active, 'Turn retraction prefix');
    if (target.generation > 0 && active.length === 0) {
        throw new Error('Turn retraction cannot preserve a non-zero generation without its marker');
    }
    return {
        status: 'committed',
        generation: target.generation,
        active,
        snapshots: history.snapshots.slice(0, Math.min(artifactIndex, history.snapshots.length)),
        deletedMessageIds: deletedTurnMessageIds(artifacts.slice(artifactIndex).flatMap(({ records }) => records), input.turnId),
    };
}
export function validateRetractTurnInput(input) {
    assertMutationIdentity(input);
    assertRetractReason(input.reason);
}
export function toTurnHistoryMutationCommit(input) {
    return {
        status: input.status,
        revision: canonicalActiveHistoryRevision(input.active),
        generation: input.generation,
        messages: input.active.map(({ message }) => structuredClone(message)),
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
function unchangedSettle(active) {
    return { status: 'unchanged', active, deletedMessageIds: [] };
}
function containsToolCall(content) {
    return (Array.isArray(content) &&
        content.some((block) => typeof block === 'object' &&
            block !== null &&
            !Array.isArray(block) &&
            Reflect.get(block, 'type') === 'toolCall'));
}
function containsCompactionMarker(artifacts, turnId) {
    const markerTurnId = `${turnId}:compaction`;
    return artifacts.some(({ records }) => records.some(({ turn_id }) => turn_id === markerTurnId));
}
function assertTargetIsCurrentTail(active, turnId) {
    const markerTurnId = `${turnId}:compaction`;
    const boundary = active.findIndex(({ turn_id }) => turn_id === turnId || turn_id === markerTurnId);
    if (boundary < 0 ||
        active.slice(boundary).some(({ turn_id }) => turn_id !== turnId && turn_id !== markerTurnId)) {
        throw new Error('Retracted Turn is not the canonical history tail');
    }
}
function deletedTurnMessageIds(records, turnId) {
    const markerTurnId = `${turnId}:compaction`;
    return [
        ...new Set(records
            .filter(({ turn_id }) => turn_id === turnId || turn_id === markerTurnId)
            .map(({ message_id }) => message_id)),
    ];
}
function assertSettled(records, operation) {
    if (inspectCanonicalHistorySequence(records).status !== 'settled') {
        throw new Error(`${operation} must produce settled canonical history`);
    }
}
function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
//# sourceMappingURL=session-turn-history-mutation.js.map