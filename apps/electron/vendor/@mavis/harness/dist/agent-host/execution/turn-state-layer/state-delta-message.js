import { RECALL_POINTERS_CUSTOM_TYPE, STATE_DELTA_CUSTOM_TYPE } from './hidden-messages.js';
import { IncrementalSha256 } from '../../history/incremental-sha256.js';
/**
 * Host-owned canonical ID prefix of a delta block. It is never the user
 * message prefix, so edit, rewind and user-words retention cannot mistake it
 * for something the user wrote.
 */
export const STATE_DELTA_MESSAGE_ID_PREFIX = 'msg-delta-';
/** How every wake line, and so every delta block, begins (spec 4.4). */
export const WAKE_LINE_PREFIX = '<wake reasons="';
/**
 * What every recall-pointer block begins with, old and new. History keeps blocks
 * written under an earlier header, so reading them back tells host text from the
 * user's own words by this prefix alone, never by the header's wording.
 */
export const RECALL_POINTERS_HEADING = '可能相关的早前对话';
/**
 * The first line of recall pointers, in a delta block or a recall-pointer message.
 * The snippets come from either side of the conversation, so the heading does not
 * call them the user's own words. A snippet is an excerpt cut around the matched
 * term and usually stops before the conclusion, so the heading says outright that
 * answering from it needs the original; a wording that reads as optional leaves the
 * model answering from the excerpt instead.
 */
export const RECALL_POINTERS_HEADER = `${RECALL_POINTERS_HEADING}（每条只是截断的摘录，通常不含结论；要回答、引用或复述，必须先用 conversation_read 读原文）：`;
/**
 * The delta block (spec 9.1): one hidden message written into canonical
 * history right before the Turn's user or event message. The model sees it as
 * user-role text whose first line is the wake line; the main conversation view
 * never shows it, and the user message beside it keeps its own text and ID.
 */
export function createStateDeltaMessage(content, timestamp) {
    return {
        role: 'custom',
        customType: STATE_DELTA_CUSTOM_TYPE,
        content,
        display: false,
        timestamp,
    };
}
export function createRecallPointersMessage(content, timestamp) {
    return {
        role: 'custom',
        customType: RECALL_POINTERS_CUSTOM_TYPE,
        content,
        display: false,
        timestamp,
    };
}
/** Stable host ID for a delta block written by one history operation. */
export function stateDeltaMessageId(operationId, index) {
    const hash = new IncrementalSha256();
    hash.update(`${operationId}:${String(index)}`);
    return `${STATE_DELTA_MESSAGE_ID_PREFIX}${hash.digestHex()}`;
}
//# sourceMappingURL=state-delta-message.js.map