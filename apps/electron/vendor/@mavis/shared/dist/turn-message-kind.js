/**
 * Turn lifecycle frames share the assistant message stream with model responses.
 *
 * Compaction and review activity markers are persisted with `role: 'assistant'`
 * so they can be upserted and rendered next to the conversation, but they are
 * runtime bookkeeping: they are not model responses, never consume a turn step
 * and never carry the turn answer.
 *
 * `review_result` is intentionally absent. The review runtime rewrites the
 * model's own final response to that kind, so it remains a model response.
 */
export const TURN_LIFECYCLE_MESSAGE_KINDS = [
    'compaction_start',
    'compaction',
    'compaction_failed',
    'review_start',
    'review_failed',
    'review_aborted',
    'review_interrupted',
];
const TURN_LIFECYCLE_MESSAGE_KIND_SET = new Set(TURN_LIFECYCLE_MESSAGE_KINDS);
export function isTurnLifecycleMessageKind(kind) {
    return kind !== undefined && TURN_LIFECYCLE_MESSAGE_KIND_SET.has(kind);
}
//# sourceMappingURL=turn-message-kind.js.map