import { segmentPrefixDigestOf } from './algorithm/segment-rebuild.js';
export function mergedRebuildBase(candidate, active, hostRecordPrefix) {
    const activeIndexes = candidate.messages.map((_message, index) => {
        const source = candidate.sourceIndexes[index];
        return source === null || source === undefined || !active[source] ? null : source;
    });
    const records = candidate.messages.map((message, index) => {
        const source = activeIndexes[index];
        if (source !== null && source !== undefined)
            return active[source];
        return { messageId: `${hostRecordPrefix}:${String(index)}`, turnId: hostRecordPrefix, message };
    });
    return { records, activeIndexes };
}
/** Rewrites a rebuild planned over the merged base into a plan over the active history. */
export function mapMergedCommit(input) {
    const { result } = input.commit;
    return {
        result: {
            ...result,
            messagesBefore: input.active.length,
            tokensBefore: input.before.inputTokens,
            serializedBytesBefore: input.before.serializedBytes,
            segment: {
                ...result.segment,
                sourceIndexes: result.segment.sourceIndexes.map((index) => index === null ? null : (input.base.activeIndexes[index] ?? null)),
                coveredCount: input.activeTailStart,
                prefixDigest: segmentPrefixDigestOf(input.active.slice(0, input.activeTailStart)),
                expectedSegmentId: input.segmentId,
            },
        },
        afterCommit: input.afterCommit,
    };
}
//# sourceMappingURL=merged-rebuild.js.map