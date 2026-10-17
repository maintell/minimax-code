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
/**
 * Map a message-body `source` (see {@link LocalQueuedMessageSource}) to the
 * turn-initiator classification carried on `RunTurnInput.caller`:
 * - `undefined` / `'api'` / anything unknown → `'chat'` (direct user message)
 * - `'cron'` → `'cron'` (scheduled task drain)
 * - `'channel:*'` → `'channel_feishu'` — single bucket for all IM channels
 *   today (feishu is the only launched channel); split per platform when
 *   others ship.
 */
export function mapMessageSourceToTurnCaller(source) {
    if (source === 'cron')
        return 'cron';
    if (source?.startsWith('channel:'))
        return 'channel_feishu';
    return 'chat';
}
//# sourceMappingURL=queue-source.js.map