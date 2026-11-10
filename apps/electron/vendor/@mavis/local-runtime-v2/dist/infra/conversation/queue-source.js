/** True iff the source identifies an IM-channel item that requires platform-aware drain. */
export function isChannelQueueSource(source) {
    return source.startsWith('channel:');
}
/**
 * Collapse a queue-item source into the bounded `source` label of
 * `message_queue_op_total`. Raw `channel:<platform>` values would grow the
 * label set per platform, so all IM channels share one `channel` bucket.
 */
export function normalizeQueueSourceLabel(source) {
    if (source === 'cron')
        return 'cron';
    return isChannelQueueSource(source) ? 'channel' : 'api';
}
//# sourceMappingURL=queue-source.js.map