/** The transition left the task untouched; nothing is written. */
export const SKIP = Symbol('skip');
export const assignmentTransitions = {
    open: (sessionId, assignment) => (current) => {
        if (current)
            throw new Error(`Session already has an assignment task: ${sessionId}`);
        return assignment;
    },
    reassign: (assignment) => () => assignment,
    restore: (applied, previous) => (current) => {
        if (!current || !sameIdentity(current, applied))
            return SKIP;
        return previous
            ? {
                ...withoutKeys(previous, ['completion']),
                ...(current.completion ? { completion: current.completion } : {}),
                ...(current.pendingStart ? { pendingStart: current.pendingStart } : {}),
            }
            : undefined;
    },
    close: (completion) => (current) => {
        if (!current)
            throw new Error('Session has no assignment');
        return { ...withoutKeys(current, ['pendingStart', 'reviewError']), completion };
    },
    /** A cancelled or taken-over task is over for good: no later turn reopens it. */
    reopen: (startedAt) => (current) => {
        const completion = current?.completion;
        if (!current ||
            (!completion && !current.review && !current.reviewError) ||
            (completion !== undefined &&
                (completion.at > startedAt || completion.state !== 'completed')))
            return SKIP;
        return withoutKeys(current, ['completion', 'review', 'reviewError']);
    },
    clearPendingStart: () => (current) => current ? withoutKeys(current, ['pendingStart']) : SKIP,
    recordReport: (expected, input) => (current) => {
        if (!current || !sameIdentity(current, expected))
            return SKIP;
        return {
            ...withoutKeys(current, ['reviewError']),
            lastReportedKey: input.reportKey,
            ...(input.review ? { review: input.review } : {}),
        };
    },
    resumeReview: (turnId) => (current) => current?.review ? { ...current, review: { ...current.review, turnId } } : SKIP,
    /**
     * A review task starts checking this one. A fresh review has concluded nothing, so any
     * verdict and claim an earlier review left are dropped: the close gate is shut again
     * until the new review reports. Re-linking the very same review changes nothing.
     */
    startVerdictReview: (reviewTask) => (current) => {
        if (!current || current.completion)
            return SKIP;
        if (current.reviewTask?.sessionId === reviewTask.sessionId &&
            current.reviewTask?.reportKey === reviewTask.reportKey)
            return SKIP;
        return {
            ...withoutKeys(current, ['verdict', 'verdictClaim', 'verdictGateReleased']),
            reviewTask: { ...reviewTask },
        };
    },
    /**
     * A review reported a verdict. Redelivering the same verdict (same review task and
     * revision) and a revision older than the one stored are both no-ops, so a caller that
     * retries never double-applies. A newer verdict supersedes the old one and drops its
     * claim: the coordinator has to take the new verdict before the task can close.
     */
    recordVerdict: (verdict) => (current) => {
        if (!current || current.completion)
            return SKIP;
        const stored = current.verdict;
        if (stored && stored.reviewTaskId === verdict.reviewTaskId) {
            if (stored.revision >= verdict.revision)
                return SKIP;
            return {
                ...withoutKeys(current, ['verdictClaim']),
                verdict,
            };
        }
        return { ...withoutKeys(current, ['verdictClaim']), verdict };
    },
    /**
     * A coordinator turn took the stored verdict. Claiming the same revision again as the
     * same coordinator changes nothing; a different coordinator takes it over.
     */
    claimVerdict: (claim) => (current) => {
        const verdict = current?.verdict;
        if (!current || !verdict)
            return SKIP;
        const stored = current.verdictClaim;
        if (stored?.revision === verdict.revision && stored.by === claim.by)
            return SKIP;
        return {
            ...current,
            verdictClaim: { by: claim.by, at: claim.at, revision: verdict.revision },
        };
    },
    /**
     * A dispatched review will not report: its task failed, stopped, closed or ran past the
     * deadline. The gate is released so the task can be concluded or sent back, and the reason
     * is kept where the panel shows a task waiting for the user (reviewError).
     *
     * A verdict the review did manage to store is kept: it is the evidence of what the review
     * found, and dropping it would throw away the only trace of work the user paid for. Only
     * the link goes, so verdictGateBlock stops holding the task shut.
     *
     * A claim is kept with it. Releasing a gate is not a fact about who read what: the claim
     * records that a coordinator turn read a revision at a time, and that stays true once the
     * gate is gone. Dropping it destroyed the one fact that tells a released gate apart from a
     * verdict nobody ever read, which is what made a real "Bunny read this 65 seconds in" case
     * unprovable from the task itself. Keeping it cannot make a later round read as already
     * read: every reader of a claim is revision-bound, a new review drops it outright
     * ({@link assignmentTransitions.startVerdictReview}) and so does a newer verdict
     * ({@link assignmentTransitions.recordVerdict}).
     *
     * Which review's gate this was stays behind (verdictGateReleased). A gated task never
     * carries `assignment.review`, so once the link is gone nothing else would say a
     * conclusion for it belongs to the verdict path rather than to a report nobody is
     * reviewing — and a conclusion that writes nothing has to be able to say so.
     */
    abandonVerdictReview: (input) => (current) => {
        if (!current || current.completion || !current.reviewTask)
            return SKIP;
        return {
            ...withoutKeys(current, ['reviewTask']),
            verdictGateReleased: { reviewTaskId: current.reviewTask.sessionId, at: input.at },
            reviewError: { reportKey: input.reportKey, reason: input.reason, at: input.at },
        };
    },
    finishReview: (input) => (current) => {
        if (!current)
            return SKIP;
        const next = withoutKeys(current, [
            'review',
            'reviewRetries',
            'reviewError',
            ...(input.clearReportedKey ? ['lastReportedKey'] : []),
        ]);
        return {
            ...next,
            ...(input.reviewRetries ? { reviewRetries: input.reviewRetries } : {}),
            ...(input.completion ? { completion: input.completion } : {}),
            ...(input.reviewError ? { reviewError: input.reviewError } : {}),
        };
    },
};
function sameIdentity(current, expected) {
    return (current.assignedAt === expected.assignedAt &&
        current.assignerSessionId === expected.assignerSessionId);
}
function withoutKeys(value, keys) {
    const copy = { ...value };
    for (const key of keys)
        delete copy[key];
    return copy;
}
//# sourceMappingURL=transitions.js.map