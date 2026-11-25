import { isRecallPointersMessage, isStateDeltaMessage } from '../../agent-host/contracts.js';
import { WAKE_LINE_CUSTOM_TYPE } from '../../agent-host/preparation/turn-wake-reasons.js';
import { boundaryNotFound, HistoryMutationError } from './history-mutation-error.js';
import { copySnapshot, findHistoryArtifact, historyRecords, isRecord, isStringArray, isTypedBackgroundReminder, snapshotsBefore, unique, withoutUnpairedToolCalls, } from './history-records.js';
const EXTERNAL_USER_MESSAGE_PREFIX = 'msg-user-v1-';
export function planRewind(input, source) {
    if (input.expectedRevision !== undefined && input.expectedRevision !== source.revision) {
        throw new HistoryMutationError('revision-conflict', 'History changed since the rewind was requested');
    }
    const exact = findRewindSlice(source, input.fromUserMessageIdInclusive);
    const slice = exact ?? findDisplayOnlyRewindSlice(source, input);
    const impact = deriveRewindImpact(source, slice);
    return {
        schemaVersion: 1,
        fromUserMessageIdInclusive: input.fromUserMessageIdInclusive,
        rewindTurnDiff: input.rewindTurnDiff === true,
        ...(input.displayOnlyBoundary
            ? { displayOnlyBoundary: copyDisplayOnlyBoundary(input.displayOnlyBoundary) }
            : {}),
        generation: slice.generation,
        sourceGeneration: source.activeGeneration,
        active: slice.active,
        snapshots: slice.snapshots,
        sourceRevision: source.revision,
        ...(exact
            ? impact
            : includeDisplayAffectedTurns(impact, slice, input.displayOnlyBoundary?.affectedTurnIds)),
    };
}
function findRewindSlice(source, boundary) {
    const artifact = findHistoryArtifact(source, boundary);
    if (!artifact)
        return undefined;
    const index = artifact.records.findIndex((record) => record.message_id === boundary);
    if (index < 0)
        return undefined;
    const target = artifact.records[index];
    if (!target ||
        target.message.role !== 'user' ||
        !target.message_id.startsWith(EXTERNAL_USER_MESSAGE_PREFIX)) {
        throw new HistoryMutationError('boundary-invalid', 'History rewind target is not an external user envelope');
    }
    return {
        generation: artifact.generation,
        active: withoutUnpairedToolCalls(artifact.records.slice(0, leadingHostMessagesStart(artifact.records, index))),
        snapshots: snapshotsBefore(source, artifact.generation),
    };
}
/**
 * The hidden host messages written right before a user message go with it on
 * rewind: the delta block (spec 9.1), and before a steer its wake line (4.4)
 * and recall pointers (15.7).
 */
function leadingHostMessagesStart(records, userIndex) {
    let start = userIndex;
    while (start > 0 && isLeadingHostMessage(records[start - 1]?.message))
        start -= 1;
    return start;
}
function isLeadingHostMessage(message) {
    return (isStateDeltaMessage(message) ||
        isRecallPointersMessage(message) ||
        (message?.role === 'custom' && message['customType'] === WAKE_LINE_CUSTOM_TYPE));
}
function findDisplayOnlyRewindSlice(source, input) {
    const boundary = input.displayOnlyBoundary;
    if (!boundary)
        boundaryNotFound(input.fromUserMessageIdInclusive);
    const targetRecords = historyRecords(source.snapshots, source.active).filter((record) => record.turn_id === boundary.turnId);
    if (targetRecords.length > 0)
        return reminderOnlyRewindSlice(source, boundary, targetRecords);
    const laterBoundary = boundary.subsequentUserMessageIds.find((messageId) => findHistoryArtifact(source, messageId) !== undefined);
    const later = laterBoundary ? findRewindSlice(source, laterBoundary) : undefined;
    if (later)
        return later;
    return {
        generation: source.activeGeneration,
        active: withoutUnpairedToolCalls(source.active),
        snapshots: source.snapshots.map(copySnapshot),
    };
}
/**
 * The initial LLM hook can persist a hidden reminder or delta block before the
 * user envelope. If interrupted there, rewind that active suffix; never
 * reinterpret real conversation records or rewrite an archived generation as a
 * reminder-only turn.
 */
function reminderOnlyRewindSlice(source, boundary, targetRecords) {
    if (targetRecords.some((record) => !isTypedBackgroundReminder(record.message) && !isStateDeltaMessage(record.message)) ||
        source.snapshots.some((snapshot) => snapshot.records.some((record) => record.turn_id === boundary.turnId))) {
        throw new HistoryMutationError('boundary-invalid', 'Display-only rewind target Turn is partially present in Canonical History');
    }
    const index = source.active.findIndex((record) => record.turn_id === boundary.turnId);
    return {
        generation: source.activeGeneration,
        active: withoutUnpairedToolCalls(source.active.slice(0, index)),
        snapshots: source.snapshots.map(copySnapshot),
    };
}
function deriveRewindImpact(source, slice) {
    const before = historyRecords(source.snapshots, source.active);
    const after = historyRecords(slice.snapshots, slice.active);
    const retainedMessageIds = new Set(after.map((record) => record.message_id));
    const deleted = firstByMessageId(before.filter((record) => !retainedMessageIds.has(record.message_id)));
    return {
        deletedMessageIds: deleted.map((record) => record.message_id),
        ...splitAffectedTurns(unique(deleted.map((record) => record.turn_id)), after),
    };
}
function firstByMessageId(records) {
    const seen = new Set();
    return records.filter((record) => {
        if (seen.has(record.message_id))
            return false;
        seen.add(record.message_id);
        return true;
    });
}
function includeDisplayAffectedTurns(impact, slice, displayAffectedTurnIds = []) {
    return {
        ...impact,
        ...splitAffectedTurns(unique([...impact.affectedTurnIds, ...displayAffectedTurnIds]), historyRecords(slice.snapshots, slice.active)),
    };
}
function splitAffectedTurns(affectedTurnIds, retained) {
    const retainedTurnIds = new Set(retained.map((record) => record.turn_id));
    const partiallyRetainedTurnIds = affectedTurnIds.filter((turnId) => retainedTurnIds.has(turnId));
    const partial = new Set(partiallyRetainedTurnIds);
    return {
        affectedTurnIds,
        fullyDeletedTurnIds: affectedTurnIds.filter((turnId) => !partial.has(turnId)),
        partiallyRetainedTurnIds,
    };
}
export function encodeRewindOperationData(plan) {
    return {
        schemaVersion: 1,
        fromUserMessageIdInclusive: plan.fromUserMessageIdInclusive,
        rewindTurnDiff: plan.rewindTurnDiff,
        ...(plan.displayOnlyBoundary
            ? { displayOnlyBoundary: copyDisplayOnlyBoundary(plan.displayOnlyBoundary) }
            : {}),
        deletedMessageIds: plan.deletedMessageIds,
        affectedTurnIds: plan.affectedTurnIds,
        fullyDeletedTurnIds: plan.fullyDeletedTurnIds,
        partiallyRetainedTurnIds: plan.partiallyRetainedTurnIds,
    };
}
/** Decodes a resumed stage and requires it to belong to the same request. */
export function decodeRewindOperationData(value, input) {
    if (!isRewindOperationData(value)) {
        throw new HistoryMutationError('chain-corrupt', 'Persisted Rewind operation data is invalid');
    }
    if (value.fromUserMessageIdInclusive !== input.fromUserMessageIdInclusive ||
        value.rewindTurnDiff !== (input.rewindTurnDiff === true) ||
        !sameDisplayOnlyBoundary(value.displayOnlyBoundary, input.displayOnlyBoundary)) {
        throw new HistoryMutationError('identity-conflict', 'Operation ID was already used for a different Rewind request');
    }
    return value;
}
function isRewindOperationData(value) {
    return (isRecord(value) &&
        value['schemaVersion'] === 1 &&
        typeof value['fromUserMessageIdInclusive'] === 'string' &&
        typeof value['rewindTurnDiff'] === 'boolean' &&
        (value['displayOnlyBoundary'] === undefined ||
            isDisplayOnlyBoundary(value['displayOnlyBoundary'])) &&
        isStringArray(value['deletedMessageIds']) &&
        isStringArray(value['affectedTurnIds']) &&
        isStringArray(value['fullyDeletedTurnIds']) &&
        isStringArray(value['partiallyRetainedTurnIds']));
}
function isDisplayOnlyBoundary(value) {
    return (isRecord(value) &&
        typeof value['turnId'] === 'string' &&
        value['turnId'].length > 0 &&
        isStringArray(value['subsequentUserMessageIds']) &&
        value['subsequentUserMessageIds'].every((id) => id.startsWith(EXTERNAL_USER_MESSAGE_PREFIX)) &&
        isStringArray(value['affectedTurnIds']));
}
function copyDisplayOnlyBoundary(boundary) {
    return {
        turnId: boundary.turnId,
        subsequentUserMessageIds: [...boundary.subsequentUserMessageIds],
        affectedTurnIds: [...boundary.affectedTurnIds],
    };
}
function sameDisplayOnlyBoundary(left, right) {
    if (!left || !right)
        return left === right;
    return (left.turnId === right.turnId &&
        sameStringArray(left.subsequentUserMessageIds, right.subsequentUserMessageIds) &&
        sameStringArray(left.affectedTurnIds, right.affectedTurnIds));
}
function sameStringArray(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
//# sourceMappingURL=rewind-plan.js.map