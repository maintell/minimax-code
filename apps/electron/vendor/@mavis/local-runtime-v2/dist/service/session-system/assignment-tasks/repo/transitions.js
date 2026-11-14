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
            ...withoutKeys(current, ['verdict', 'verdictClaim']),
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