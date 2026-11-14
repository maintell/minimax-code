import { checkSegmentSize, segmentPrefixDigestOf } from './algorithm/segment-rebuild.js';
/** Tool result text past this in the active history starts a background compaction (10.2). */
const TOOL_RESULT_WATERMARK_BYTES = 256 * 1_024;
/** Whether the tool result text in `messages` is past the byte watermark. */
export function exceedsToolResultWatermark(messages) {
    let bytes = 0;
    for (const message of messages) {
        if (message.role !== 'toolResult')
            continue;
        const texts = message.content.filter((block) => block.type === 'text');
        bytes += texts.reduce((total, block) => total + Buffer.byteLength(block.text), 0);
        bytes += Math.max(0, texts.length - 1);
        if (bytes > TOOL_RESULT_WATERMARK_BYTES)
            return true;
    }
    return false;
}
/**
 * Length of the rebuilt prefix in a segment plan: the header and retained
 * text, which are new host records or records from the covered range; the
 * records after the covered range that follow are the segment's own.
 */
export function rebuiltPrefixLength(sourceIndexes, coveredCount) {
    const end = sourceIndexes.findIndex((index) => index !== null && index >= coveredCount);
    return end < 0 ? sourceIndexes.length : end;
}
/** Why a prepared commit candidate cannot be committed now. */
export function notReadyReason(prepared) {
    return prepared.kind === 'rejected' ? prepared.reason : 'deferred';
}
/**
 * How much the handoff header can grow once the compactor's delta is written
 * (11.6, 11.7): the ledger section up to its share when the delta touches the
 * ledger. Nothing else in the candidate depends on the external writes.
 */
export function externalGrowth(candidate, generated, shares) {
    const { sectionTokens } = candidate.prefix.header;
    return generated.references.ledger.length > 0
        ? Math.max(0, shares.ledger - sectionTokens.ledger)
        : 0;
}
/** Background results must stay under 80% of S; synchronous ones under their limit (11.4, 11.9). */
export function sizeVerdict(input) {
    const { afterTokens, currentTokens, softLine, limit } = input;
    if (limit === undefined)
        return checkSegmentSize({ afterTokens, currentTokens, softLine });
    return afterTokens <= limit && afterTokens <= currentTokens ? 'fits' : 'over_hard_line';
}
/**
 * Whether a background result over 80% of the soft line goes over only by its uncovered
 * tail and still shrinks the history, so Turn start commits it (dogfood fixes spec 8.5):
 * system layer, header and retained text within 80% of S, and strictly fewer tokens than
 * the history it replaces.
 */
export function overSoftLineOnlyByTail(input) {
    return (input.prefixTokens <= Math.floor(input.softLine * 0.8) &&
        input.totalTokens < input.currentTokens);
}
/** Why the current segment no longer matches the one a rebuild was built from, if it does not. */
export function prefixConflict(generated, current) {
    if (current.segmentId !== generated.segmentId)
        return 'segment_changed';
    if (current.records.length < generated.coveredCount)
        return 'prefix_changed';
    return segmentPrefixDigestOf(current.records.slice(0, generated.coveredCount)) ===
        generated.prefixDigest
        ? undefined
        : 'prefix_changed';
}
/**
 * First record of the running Turn at or after `from`; everything from there is
 * the Turn's verbatim tail.
 */
export function currentTurnStart(records, turnId, from = 0) {
    for (let index = Math.min(from, records.length); index < records.length; index += 1) {
        const record = records[index];
        if (record.turnId === turnId || record.turnId.startsWith(`${turnId}:`))
            return index;
    }
    return records.length;
}
//# sourceMappingURL=segment-checks.js.map