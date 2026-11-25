import { assistantHasToolCalls, resolveCompletedToolGroup } from './completed-tool-group.js';
import { computeHistoryDigest } from './history-digest.js';
import { isExternalUserHistoryRecord } from './external-user-message.js';
export class HistoryBoundaryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HistoryBoundaryError';
    }
}
export function resolveHistoryBoundary(input) {
    assertUniqueMessageIds(input.records);
    const anchorOrdinal = input.records.findIndex((record) => record.messageId === input.anchorMessageId);
    if (anchorOrdinal < 0)
        throw new HistoryBoundaryError('history anchor was not found');
    const anchor = input.records[anchorOrdinal];
    if (!anchor)
        throw new HistoryBoundaryError('history anchor was not found');
    let retainedEndExclusive = input.cutPolicy === 'before_anchor' ? anchorOrdinal : anchorOrdinal + 1;
    let executionMessageIds = [];
    if (input.cutPolicy === 'through_turn') {
        if (anchor.message.role !== 'user') {
            throw new HistoryBoundaryError('through_turn requires a user anchor');
        }
        retainedEndExclusive = findTurnEndExclusive(input.records, anchorOrdinal);
        executionMessageIds = validateSettledTurn(input.records, anchorOrdinal, retainedEndExclusive);
    }
    else if (input.cutPolicy === 'through_completed_group' && assistantHasToolCalls(anchor)) {
        const group = resolveCompletedToolGroup(input.records, anchorOrdinal);
        retainedEndExclusive = group.endExclusive;
        executionMessageIds = group.executionMessageIds;
    }
    else if (input.requireSettledPrefix &&
        input.cutPolicy === 'through_anchor' &&
        assistantHasToolCalls(anchor)) {
        resolveCompletedToolGroup(input.records, anchorOrdinal);
        throw new HistoryBoundaryError('through_anchor would retain an incomplete tool group');
    }
    const records = structuredClone(input.records.slice(0, retainedEndExclusive));
    if (input.requireSettledPrefix)
        validateSettledHistory(records);
    const boundary = records.at(-1);
    return {
        records,
        proof: {
            kind: 'cut',
            sourceHistoryRevision: input.sourceHistoryRevision,
            artifactId: input.artifact.artifactId,
            artifactRevision: input.artifact.revision,
            artifactScope: input.artifact.scope,
            anchorMessageId: anchor.messageId,
            anchorRole: String(anchor.message.role),
            anchorOrdinal,
            cutPolicy: input.cutPolicy,
            retainedEndExclusive,
            resolvedBoundaryMessageId: boundary?.messageId ?? null,
            executionMessageIds,
            prefixDigest: computeHistoryDigest(records),
            settled: true,
        },
    };
}
export function resolveEntireHistory(input) {
    assertUniqueMessageIds(input.records);
    if (input.records.length === 0)
        throw new HistoryBoundaryError('source session has no history');
    validateSettledHistory(input.records);
    const records = structuredClone([...input.records]);
    return {
        records,
        proof: {
            kind: 'entire_history',
            sourceHistoryRevision: input.sourceHistoryRevision,
            artifactId: input.artifact.artifactId,
            artifactRevision: input.artifact.revision,
            artifactScope: input.artifact.scope,
            retainedEndExclusive: records.length,
            resolvedBoundaryMessageId: records.at(-1)?.messageId ?? null,
            executionMessageIds: collectExecutionMessageIds(records),
            prefixDigest: computeHistoryDigest(records),
            settled: true,
        },
    };
}
function findTurnEndExclusive(records, anchorOrdinal) {
    for (let ordinal = anchorOrdinal + 1; ordinal < records.length; ordinal += 1) {
        if (isExternalUserHistoryRecord(records[ordinal]))
            return ordinal;
    }
    return records.length;
}
function validateSettledTurn(records, anchorOrdinal, endExclusive) {
    const executionMessageIds = [];
    let assistantSeen = false;
    for (let ordinal = anchorOrdinal + 1; ordinal < endExclusive; ordinal += 1) {
        const record = records[ordinal];
        if (!record || record.message.role !== 'assistant')
            continue;
        assistantSeen = true;
        if (!assistantHasToolCalls(record))
            continue;
        const group = resolveCompletedToolGroup(records, ordinal);
        if (group.endExclusive > endExclusive) {
            throw new HistoryBoundaryError('through_turn would retain an incomplete tool group');
        }
        executionMessageIds.push(...group.executionMessageIds);
        ordinal = group.endExclusive - 1;
    }
    if (!assistantSeen) {
        throw new HistoryBoundaryError('through_turn requires a settled assistant response');
    }
    return executionMessageIds;
}
function validateSettledHistory(records) {
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
        const record = records[ordinal];
        if (!record)
            continue;
        if (record.message.role === 'toolResult' || record.message.role === 'bashExecution') {
            throw new HistoryBoundaryError(`history contains orphan ${String(record.message.role)}`);
        }
        if (!assistantHasToolCalls(record))
            continue;
        const group = resolveCompletedToolGroup(records, ordinal);
        ordinal = group.endExclusive - 1;
    }
}
function collectExecutionMessageIds(records) {
    const ids = [];
    for (let ordinal = 0; ordinal < records.length; ordinal += 1) {
        const record = records[ordinal];
        if (!record || !assistantHasToolCalls(record))
            continue;
        const group = resolveCompletedToolGroup(records, ordinal);
        ids.push(...group.executionMessageIds);
        ordinal = group.endExclusive - 1;
    }
    return ids;
}
function assertUniqueMessageIds(records) {
    const ids = new Set();
    for (const record of records) {
        if (ids.has(record.messageId))
            throw new HistoryBoundaryError(`duplicate message id ${record.messageId}`);
        ids.add(record.messageId);
    }
}
//# sourceMappingURL=history-boundary.js.map