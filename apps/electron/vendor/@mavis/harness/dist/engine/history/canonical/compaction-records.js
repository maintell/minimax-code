import { sameJson, withoutHistoryArtifact, } from './canonical-record.js';
import { canonicalHistoryMessage, canonicalRecord, } from './record-identity.js';
/** 压缩替换记录（不含标记）：一条原生摘要，加上按结构保留的当前用户尾部。 */
export function planCompactionRecords(change, active) {
    const currentUserTail = readCurrentUserTail(change, active);
    const baseMessages = currentUserTail?.baseMessages ?? change.messages;
    const replacement = baseMessages.map((message, index) => canonicalRecord({ change, message, turnId: `${change.turnId}:compaction`, index }));
    assertCheckpointReplacement(replacement);
    return currentUserTail ? [...replacement, ...currentUserTail.records] : replacement;
}
function assertCheckpointReplacement(replacement) {
    if (replacement[0]?.message.role !== 'compactionSummary' ||
        (replacement.length !== 1 &&
            !(replacement.length === 2 && isSideChatModeMessage(replacement[1]?.message)))) {
        throw new TypeError('Canonical checkpoint compaction must contain one native summary.');
    }
}
function isSideChatModeMessage(message) {
    return (typeof message === 'object' &&
        message !== null &&
        Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === 'sidechat_mode' &&
        Reflect.get(message, 'display') === false);
}
function readCurrentUserTail(change, active) {
    const sourceIndex = change.currentUserSourceIndex;
    if (sourceIndex === undefined)
        return undefined;
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= active.length) {
        throw new TypeError('Canonical current-user tail source lineage is invalid.');
    }
    const markerCount = change.placedMarkerCount ?? 1;
    if (!Number.isSafeInteger(markerCount) || markerCount < 1) {
        throw new TypeError('Canonical current-user tail marker count is invalid.');
    }
    const tailLength = markerCount + 1;
    if (change.messages.length < tailLength) {
        throw new TypeError('Canonical current-user tail is incomplete.');
    }
    const baseLength = change.messages.length - tailLength;
    const markers = change.messages.slice(baseLength, -1);
    const userMessage = change.messages.at(-1);
    const source = requireCurrentUserSource(active[sourceIndex]);
    const normalizedMarkers = markers.map(requireHiddenTypedCustom);
    const normalizedUser = requireExactCurrentUserMessage(userMessage, source);
    return {
        baseMessages: change.messages.slice(0, baseLength),
        records: [
            ...normalizedMarkers.map((message, offset) => canonicalRecord({
                change,
                message,
                turnId: `${change.turnId}:compaction`,
                index: baseLength + offset,
            })),
            { ...withoutHistoryArtifact(source), message: normalizedUser },
        ],
    };
}
/**
 * The kept tail reuses the source record (id, turn and payload) as-is, so only
 * its role is checked here, not its id format: cron and other runtime users
 * have no `msg-user-v1-*` display identity, and lineage only tracks external
 * ids (history-lineage.ts).
 */
function requireCurrentUserSource(source) {
    if (source?.message.role !== 'user') {
        throw new TypeError('Canonical current-user tail source is not a user message.');
    }
    return source;
}
function requireHiddenTypedCustom(value) {
    if (!isHiddenTypedCustom(value)) {
        throw new TypeError('Canonical current-user tail marker is invalid.');
    }
    return canonicalHistoryMessage(value);
}
function requireExactCurrentUserMessage(value, source) {
    const normalized = canonicalHistoryMessage(value);
    if (normalized.role !== 'user' || !sameJson(source.message, normalized)) {
        throw new TypeError(`Canonical current-user tail changed external user payload: ${source.message_id}`);
    }
    return normalized;
}
function isHiddenTypedCustom(value) {
    return (!!value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Reflect.get(value, 'role') === 'custom' &&
        Reflect.get(value, 'display') === false &&
        typeof Reflect.get(value, 'customType') === 'string' &&
        Boolean(Reflect.get(value, 'customType').trim()) &&
        typeof Reflect.get(value, 'timestamp') === 'number' &&
        Number.isFinite(Reflect.get(value, 'timestamp')));
}
//# sourceMappingURL=compaction-records.js.map