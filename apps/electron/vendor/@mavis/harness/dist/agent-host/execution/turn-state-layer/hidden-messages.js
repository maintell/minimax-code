/**
 * Hidden messages the Turn state layer writes into canonical history: the per-Turn delta block
 * (spec 9.1) and the recall pointers before a steered user message (spec 15.7). The model reads
 * them; the conversation view does not show them. Compaction, rewind and history identity tell
 * them apart by these types.
 */
export const STATE_DELTA_CUSTOM_TYPE = 'bunny_state_delta';
export const RECALL_POINTERS_CUSTOM_TYPE = 'bunny_recall_pointers';
/**
 * Whether a history message is a delta block. A segment rebuild strips these
 * from the retained turns, and a rewind drops the one right before the user
 * message it removes.
 */
export function isStateDeltaMessage(message) {
    return isCustomMessageOf(message, STATE_DELTA_CUSTOM_TYPE);
}
/** Whether a history message is the hidden recall-pointer message before a steered user message. */
export function isRecallPointersMessage(message) {
    return isCustomMessageOf(message, RECALL_POINTERS_CUSTOM_TYPE);
}
function isCustomMessageOf(message, customType) {
    return (typeof message === 'object' &&
        message !== null &&
        Reflect.get(message, 'role') === 'custom' &&
        Reflect.get(message, 'customType') === customType);
}
//# sourceMappingURL=hidden-messages.js.map