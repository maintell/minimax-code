import { isRecord, readCompactionLifecycleMetadata } from './context-compaction.js';
import { readSegmentCheckpointPlan } from './segment-checkpoint-plan.js';
export function readCompactionCommitMetadata(value) {
    const lifecycle = readCompactionLifecycleMetadata(value);
    if (!lifecycle || !isRecord(value))
        return undefined;
    const summary = Reflect.get(value, 'summary');
    if (typeof summary !== 'string')
        return undefined;
    const tail = readOptionalCurrentUserTail(value, lifecycle);
    if (tail === null)
        return undefined;
    if (lifecycle.method === 'llm_segment_checkpoint') {
        return readSegmentCommitMetadata(value, lifecycle, summary, tail);
    }
    return readCheckpointCommitMetadata(lifecycle, summary, tail);
}
/**
 * A segment plan names every kept record. When runner placement moved the
 * current user behind hidden markers, the markers become new host records and
 * the current user keeps its source index at the tail of the plan.
 */
function readSegmentCommitMetadata(value, lifecycle, summary, tail) {
    const sourceCount = tail === undefined
        ? lifecycle.messagesAfter
        : lifecycle.messagesAfter - 1 - tail.placedMarkerCount;
    if (sourceCount < 1)
        return undefined;
    const base = readSegmentCheckpointPlan(value, sourceCount);
    if (!base)
        return undefined;
    if (tail !== undefined && base.sourceIndexes.includes(tail.currentUserSourceIndex)) {
        return undefined;
    }
    const segment = tail === undefined
        ? base
        : Object.freeze({
            ...base,
            sourceIndexes: Object.freeze([
                ...base.sourceIndexes,
                ...Array.from({ length: tail.placedMarkerCount }, () => null),
                tail.currentUserSourceIndex,
            ]),
        });
    return Object.freeze({
        compactionId: lifecycle.compactionId,
        method: 'llm_segment_checkpoint',
        summary,
        segment,
    });
}
function readCheckpointCommitMetadata(lifecycle, summary, tail) {
    // Native summary, optional owned mode, then the exact markers + external user tail.
    if (tail !== undefined &&
        lifecycle.messagesAfter !== 2 + tail.placedMarkerCount &&
        lifecycle.messagesAfter !== 3 + tail.placedMarkerCount)
        return undefined;
    return Object.freeze({
        compactionId: lifecycle.compactionId,
        method: 'llm_checkpoint',
        summary,
        ...currentUserTailFields(tail),
    });
}
function currentUserTailFields(tail) {
    return tail === undefined
        ? {}
        : {
            currentUserSourceIndex: tail.currentUserSourceIndex,
            placedMarkerCount: tail.placedMarkerCount,
        };
}
/**
 * Reads the placement-owned tail lineage. `placedMarkerCount` defaults to 1 so
 * metadata persisted before multi-marker placement stays readable; it is
 * invalid without `currentUserSourceIndex`. Returns null for invalid input.
 */
function readOptionalCurrentUserTail(value, lifecycle) {
    const hasMarkerCount = Object.hasOwn(value, 'placedMarkerCount');
    if (!Object.hasOwn(value, 'currentUserSourceIndex'))
        return hasMarkerCount ? null : undefined;
    const index = Reflect.get(value, 'currentUserSourceIndex');
    if (!isSourceIndexInRange(index, lifecycle.messagesBefore))
        return null;
    if (!hasMarkerCount)
        return { currentUserSourceIndex: index, placedMarkerCount: 1 };
    const count = Reflect.get(value, 'placedMarkerCount');
    return isPositiveSafeInteger(count)
        ? { currentUserSourceIndex: index, placedMarkerCount: count }
        : null;
}
function isSourceIndexInRange(value, messagesBefore) {
    return (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < messagesBefore);
}
function isPositiveSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
//# sourceMappingURL=compaction-commit-metadata.js.map