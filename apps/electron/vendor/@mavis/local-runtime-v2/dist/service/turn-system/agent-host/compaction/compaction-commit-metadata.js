import { isRecord, readCompactionLifecycleMetadata } from './context-compaction.js';
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
    return lifecycle.method === 'llm_checkpoint'
        ? readCheckpointCommitMetadata(lifecycle, summary, tail)
        : readToolResultCommitMetadata(value, lifecycle, summary, tail);
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
function readToolResultCommitMetadata(value, lifecycle, summary, tail) {
    if (lifecycle.method === 'llm_checkpoint')
        return undefined;
    const replacementSourceIndexes = Reflect.get(value, 'replacementSourceIndexes');
    const expectedSourceCount = tail === undefined
        ? lifecycle.messagesAfter
        : lifecycle.messagesAfter - 1 - tail.placedMarkerCount;
    if (!Array.isArray(replacementSourceIndexes) ||
        expectedSourceCount < 0 ||
        replacementSourceIndexes.length !== expectedSourceCount ||
        !replacementSourceIndexes.every((index, position) => Number.isSafeInteger(index) &&
            index >= 0 &&
            index < lifecycle.messagesBefore &&
            index !== tail?.currentUserSourceIndex &&
            (position === 0 || index > replacementSourceIndexes[position - 1]))) {
        return undefined;
    }
    return Object.freeze({
        compactionId: lifecycle.compactionId,
        method: lifecycle.method,
        summary,
        replacementSourceIndexes: Object.freeze([...replacementSourceIndexes]),
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