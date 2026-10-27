import { isOrdinaryQuestionnaireResponseOrigin } from '@mavis/shared/questionnaire';
/** Resolves exact user-query authorship before execution and display diverge. */
export function resolveGenuineUserQueryText(input) {
    if (input.provenance.source === 'background-task')
        return '';
    const displayContent = input.delivery?.displayContent;
    if (typeof displayContent === 'string' && displayContent.length > 0)
        return displayContent;
    if (input.delivery?.hideUserMessage === true)
        return '';
    return isUserAuthoredSource(input.provenance.source) ? input.input.text : '';
}
export function isUserAuthoredSource(source) {
    return (source === 'api' ||
        source === 'code_review' ||
        source === 'channel' ||
        source.startsWith('channel:'));
}
/** Identifies queued user work that must preempt an autonomous Goal continuation. */
export function hasPriorityUserQueueItem(items) {
    return items.some(({ source }) => source === 'api' ||
        source === 'questionnaire' ||
        source === 'communication' ||
        source === 'code_review' ||
        source.startsWith('channel:'));
}
/**
 * AskUser v2 sync wait: true when the user queued new input after `sinceMs`
 * (Desktop queues while a Turn runs by default, so such a message never
 * reaches the Turn as steering). Only user-authored sources count; machine
 * input (Goal continuation, cron, background tasks, questionnaire answers —
 * including an answer re-queued with source `api` after its Turn closed) must
 * not end the wait. Requeued user items keep their original `createdAt`, so
 * input that predates the wait is not counted twice.
 *
 * "User" is exactly isUserAuthoredSource (api, code_review, channel*), the
 * same rule that decides genuine user query text. `communication` is
 * deliberately excluded: it is another Agent's session-send, not the person
 * the question is waiting for, so it must not end their wait (decided with
 * the product owner, 2026-09-24).
 */
export function hasUserQueueInputSince(items, sinceMs) {
    return items.some((item) => item.createdAt >= sinceMs &&
        isUserAuthoredSource(item.source) &&
        !isOrdinaryQuestionnaireResponseOrigin(item.message.origin));
}
//# sourceMappingURL=message-query-authorship.js.map