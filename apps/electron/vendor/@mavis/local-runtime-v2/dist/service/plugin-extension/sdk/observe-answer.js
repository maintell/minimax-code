/** Prefix of every refusal reason the permission gate gives the model (policy, hook, user). */
export const DENIED_PREFIX = 'Permission denied';
/**
 * Upper bound of `turn.complete.answer`, in UTF-8 bytes.
 * @internal Exported only for focused tests.
 */
export const TURN_COMPLETE_ANSWER_MAX_BYTES = 32 * 1024;
/**
 * Cut at a character boundary, so the event stays valid text whatever the answer holds.
 * @internal Exported only for focused tests.
 */
export function truncateAnswer(text) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length <= TURN_COMPLETE_ANSWER_MAX_BYTES)
        return { answer: text };
    let end = TURN_COMPLETE_ANSWER_MAX_BYTES;
    // A byte `10xxxxxx` continues a character started earlier.
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80)
        end -= 1;
    return { answer: bytes.subarray(0, end).toString('utf8'), answerTruncated: true };
}
/** How a terminal task row ended, as `turn.complete.reason`. */
export function reasonOf(task, finalText) {
    if (task.status === 'succeeded')
        return 'answer';
    if (task.status === 'canceled')
        return 'aborted';
    const { code = '', message = '' } = task.lastError ?? {};
    const refused = /PERMISSION|DENIED/u.test(code) ||
        message.startsWith(DENIED_PREFIX) ||
        finalText?.startsWith(DENIED_PREFIX) === true;
    return refused ? 'refusal' : 'error';
}
const TURN_STATUS_REASONS = {
    completed: 'answer',
    aborted: 'aborted',
    error: 'error',
};
/** What only the spawning plugin receives; without a read reason, the turn's status says it. */
export function answerFields(owned, turnStatus) {
    return {
        ...(owned.answer === undefined ? {} : truncateAnswer(owned.answer)),
        reason: owned.reason ?? TURN_STATUS_REASONS[String(turnStatus)] ?? 'error',
    };
}
//# sourceMappingURL=observe-answer.js.map