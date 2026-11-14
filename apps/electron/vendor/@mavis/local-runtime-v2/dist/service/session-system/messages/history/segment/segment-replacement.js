import { SegmentCheckpointConflictError, } from './segment-checkpoint.js';
import { isStateDeltaRecord, readSegmentId, segmentPrefixDigest } from './segment-prefix.js';
/**
 * Validates a segment rebuild against the active history inside the history
 * lane, then keeps every planned source record verbatim and gives new host
 * records fresh ids. Dropping a covered external user is allowed here: its
 * words live on in the handoff header or in a host preview record.
 */
export function segmentReplacementEnvelopes(change, active, records) {
    assertSegmentPrefix(change, active);
    const indexes = change.segmentSourceIndexes;
    if (!Array.isArray(indexes) || indexes.length !== change.messages.length) {
        throw new SegmentCheckpointConflictError('invalid-plan');
    }
    let previous = -1;
    const kept = new Set();
    const replacement = change.messages.map((message, index) => {
        const sourceIndex = indexes[index];
        if (sourceIndex === null || sourceIndex === undefined)
            return records.create(message, index);
        const source = keptSegmentSource(() => records.roleOf(message), sourceIndex, previous, active);
        previous = sourceIndex;
        kept.add(sourceIndex);
        return records.keep(source);
    });
    if (replacement[0]?.message.role !== 'compactionSummary' || indexes[0] !== null) {
        throw new SegmentCheckpointConflictError('invalid-plan');
    }
    // Every record after the covered range stays, except old delta blocks (spec 9.1).
    for (let index = change.segmentCoveredCount; index < active.length; index += 1) {
        if (!kept.has(index) && !isStateDeltaRecord(active[index]?.message))
            throw new SegmentCheckpointConflictError('invalid-plan');
    }
    return replacement;
}
/** The segment is still the one the compaction read, and its covered prefix is unchanged. */
function assertSegmentPrefix(change, active) {
    if (readSegmentId(active) !== change.segmentExpectedId) {
        throw new SegmentCheckpointConflictError('segment-changed');
    }
    const covered = change.segmentCoveredCount;
    const inRange = Number.isSafeInteger(covered) && covered >= 0 && covered <= active.length;
    if (!inRange || segmentPrefixDigest(active.slice(0, covered)) !== change.segmentPrefixDigest) {
        throw new SegmentCheckpointConflictError('prefix-changed');
    }
}
/** A kept record: an ascending source index whose record has the same role. */
function keptSegmentSource(roleOf, sourceIndex, previous, active) {
    const source = active[sourceIndex];
    if (!Number.isSafeInteger(sourceIndex) ||
        sourceIndex <= previous ||
        !source ||
        roleOf() !== source.message.role) {
        throw new SegmentCheckpointConflictError('invalid-plan');
    }
    return source;
}
//# sourceMappingURL=segment-replacement.js.map