/**
 * Host-neutral send_to_user surface: the tool name, the delivery reader and the
 * plain-text ending follow-up copy. Every module behind this entry is pure (no
 * Node IO, no process state); the closure test in test/neutral-subpaths keeps it
 * that way. The files stay under desktop/ because Desktop tools import them by
 * relative path.
 */
export { readSendToUserDelivery, SEND_TO_USER_TOOL_NAME, } from '../desktop/local-assignment-tools.js';
export { emptyEndingFollowUp, PLAIN_TEXT_ENDING_FOLLOW_UP, plainTextEndingFollowUpAfterDelivery, } from '../desktop/local-mavis-coordinator-text.js';
//# sourceMappingURL=index.js.map