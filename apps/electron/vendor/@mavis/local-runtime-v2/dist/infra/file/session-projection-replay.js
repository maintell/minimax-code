export function replayLocalSessionLedger(sessionId, events, base = {}) {
    const projection = {
        sessionId,
        ...(base.record ? { record: base.record } : {}),
        displayMessages: [...(base.displayMessages ?? [])],
        piHistory: [...(base.piHistory ?? [])],
        ...(base.fileApiUploads ? { fileApiUploads: { ...base.fileApiUploads } } : {}),
        deleted: base.deleted ?? false,
        ...(base.watermark ? { watermark: base.watermark } : {}),
    };
    const displayMessageIndexes = new Map();
    indexDisplayMessages(projection.displayMessages, displayMessageIndexes);
    for (const event of [...events].sort(compareLedgerEvents)) {
        if (event.sessionId !== sessionId)
            continue;
        projection.watermark = {
            sessionId,
            lastSeq: event.seq,
            lastEventId: event.eventId,
            updatedAtMs: event.createdAtMs,
        };
        applyLedgerEvent(projection, displayMessageIndexes, event);
    }
    return projection;
}
function applyLedgerEvent(projection, displayMessageIndexes, event) {
    switch (event.kind) {
        case 'session.created':
        case 'session.metadata_updated':
            projection.record = event.record;
            projection.deleted = false;
            return;
        case 'session.deleted':
            projection.record = undefined;
            projection.deleted = true;
            clearMessageProjection(projection, displayMessageIndexes);
            return;
        case 'media.file_api_uploaded':
            (projection.fileApiUploads ??= {})[`${event.contentHash}:${event.endpointHash}:${event.callerIdentityHash}:${event.ttlSec}`] = {
                contentHash: event.contentHash,
                endpointHash: event.endpointHash,
                callerIdentityHash: event.callerIdentityHash,
                ttlSec: event.ttlSec,
                fileId: event.fileId,
                createdAtMs: event.createdAtMs,
                expiresAtMs: event.expiresAtMs,
            };
            return;
        default:
            applyMessageEvent(projection, displayMessageIndexes, event);
    }
}
function applyMessageEvent(projection, displayMessageIndexes, event) {
    switch (event.kind) {
        case 'message.display_upserted':
            upsertDisplayMessage(projection.displayMessages, displayMessageIndexes, event.message);
            break;
        case 'message.pi_history_appended':
            projection.piHistory.push(...event.messages);
            break;
        case 'message.pi_history_replaced':
            projection.piHistory = [...event.messages];
            break;
        case 'message.state_deleted':
            clearMessageProjection(projection, displayMessageIndexes);
            break;
        case 'message.turn_retracted':
            retractDisplayMessages(projection, displayMessageIndexes, event.removedDisplayMsgIds);
            projection.piHistory = [...event.messages];
            break;
        case 'session.snapshot_created':
            break;
    }
}
function clearMessageProjection(projection, indexes) {
    projection.displayMessages = [];
    projection.piHistory = [];
    projection.fileApiUploads = {};
    indexes.clear();
}
function retractDisplayMessages(projection, indexes, removedDisplayMsgIds) {
    const removed = new Set(removedDisplayMsgIds);
    if (removed.size === 0)
        return;
    projection.displayMessages = projection.displayMessages.filter((message) => {
        const msgId = readDisplayMsgId(message);
        return !(msgId !== undefined && removed.has(msgId));
    });
    indexes.clear();
    indexDisplayMessages(projection.displayMessages, indexes);
}
function indexDisplayMessages(messages, indexes) {
    messages.forEach((message, index) => {
        indexes.set(readDisplayMessageKey(message), index);
    });
}
function compareLedgerEvents(left, right) {
    return left.seq - right.seq || left.eventId.localeCompare(right.eventId);
}
function upsertDisplayMessage(messages, indexes, message) {
    const key = readDisplayMessageKey(message);
    const index = indexes.get(key);
    if (index === undefined) {
        indexes.set(key, messages.length);
        messages.push(message);
        return;
    }
    messages[index] = message;
}
function readDisplayMessageKey(message) {
    const msgId = message.msg_id;
    if (typeof msgId === 'string' && msgId)
        return `msg_id:${msgId}`;
    return `json:${JSON.stringify(message)}`;
}
function readDisplayMsgId(message) {
    const msgId = message.msg_id;
    return typeof msgId === 'string' && msgId ? msgId : undefined;
}
//# sourceMappingURL=session-projection-replay.js.map