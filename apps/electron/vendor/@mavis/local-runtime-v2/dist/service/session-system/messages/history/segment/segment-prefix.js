import { createHash } from 'node:crypto';
/**
 * Digest of the first records of the active history that a Bunny background
 * compaction covered. The commit recomputes it inside the history lane: any
 * edit, rewind or replacement of those records changes it, while records
 * appended after the covered range do not.
 */
export function segmentPrefixDigest(records) {
    const hash = createHash('sha256');
    for (const record of records) {
        hash.update(JSON.stringify([record.message_id, record.turn_id, record.message]));
        hash.update('\n');
    }
    return `sha256:${hash.digest('hex')}`;
}
/**
 * Segment id: the id of the checkpoint record that opened the current segment
 * (the position-0 native summary), or null before the first checkpoint.
 */
export function readSegmentId(records) {
    const first = records[0];
    if (!first)
        return null;
    const message = first.message;
    return message !== null &&
        typeof message === 'object' &&
        Reflect.get(message, 'role') === 'compactionSummary'
        ? first.message_id
        : null;
}
/**
 * Bunny's per-Turn delta block (spec 9.1), the Turn System's
 * `STATE_DELTA_CUSTOM_TYPE`. A segment commit may leave these out of the
 * records after its covered range: kept Turns lose their old delta blocks.
 * @internal Exported only for focused tests.
 */
export const SEGMENT_STATE_DELTA_CUSTOM_TYPE = 'bunny_state_delta';
export function isStateDeltaRecord(message) {
    return (typeof message === 'object' &&
        message !== null &&
        Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === SEGMENT_STATE_DELTA_CUSTOM_TYPE);
}
//# sourceMappingURL=segment-prefix.js.map