/** An open task whose report `reportKey` the coordinator is reviewing right now. */
export function underReviewBy(assignment, coordinatorId, reportKey) {
    return (!assignment.completion &&
        assignment.review?.sessionId === coordinatorId &&
        assignment.review.reportKey === reportKey);
}
/** A running round without progress shows why (R5.5); waiting rounds are never stalled. */
export function stalled(reason) {
    return reason === undefined ? {} : { stalled: true, stallReason: reason };
}
/** A finished round whose review gave up waits for the user, with the reason (R6.4). */
export function reviewFailed(state, assignment) {
    const error = assignment?.reviewError;
    if (!error || state !== 'completed' || assignment.completion || assignment.review)
        return {};
    return { state: 'review_failed', errorMessage: error.reason };
}
/** A round that finished or failed, on a task still open and not queued to run again. */
export function endedOpenRound(state, assignment) {
    return ((state === 'completed' || state === 'failed') &&
        assignment !== undefined &&
        !assignment.completion &&
        !assignment.pendingStart);
}
//# sourceMappingURL=assignment-status-facts.js.map