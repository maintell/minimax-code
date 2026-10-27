export function hostOutputTokenCap(resolver, input) {
    const context = {
        ...(input.assemblyContext.turnIntent ? { turnIntent: input.assemblyContext.turnIntent } : {}),
    };
    const cap = resolver?.resolveOutputTokenCap(context);
    return cap === undefined
        ? {}
        : {
            hostMaxOutputTokens: cap,
            // A budgeted owner disappearing mid-turn must not remove its constraint.
            resolveHostMaxOutputTokens: () => resolver?.resolveOutputTokenCap(context) ?? 0,
        };
}
export function contentReviewOptions(input, options) {
    if (options.tuiProductPolicy === true) {
        const contentReviewRequired = options.contentReviewEnabled !== false && input.preparation.llm.managedProvider === true;
        return {
            contentReviewRequired,
            ...(contentReviewRequired ? {} : { streamUnreviewedOutput: true }),
        };
    }
    return options.cliProductPolicy === true
        ? { contentReviewRequired: input.preparation.llm.managedProvider === true }
        : {};
}
/**
 * Retry options, plus the request barrier and step stop of a Turn its owner
 * accounts in logical requests (Goal main execution).
 */
export async function requestControlledRunOptions(input, options) {
    const turn = { sessionId: input.lease.sessionId, turnId: input.lease.turnId };
    const usageRecorder = options.resolveTurnUsageRecorder?.(turn);
    const llmRetry = {
        ...(await resolveLlmRetryOptions(input, options)),
        ...(usageRecorder ? { usageRecorder } : {}),
    };
    const control = options.resolveTurnRequestControl?.(turn);
    if (!control)
        return { llmRetry };
    return {
        llmRetry: { ...llmRetry, requestLifecycle: control.requestLifecycle },
        shouldStopAfterTurn: control.shouldStopAfterStep,
        isWorkClosed: control.isWorkClosed,
    };
}
async function resolveLlmRetryOptions(input, options) {
    return (await options.resolveLlmRetry?.(input)) ?? {};
}
export function attachCommittedFacts(outcome, fileChangeObservation, backgroundTaskReadCandidates) {
    const confirmedCandidates = outcome.status === 'completed' ? [...backgroundTaskReadCandidates] : [];
    if (!fileChangeObservation && confirmedCandidates.length === 0)
        return outcome;
    const committedFacts = {
        ...outcome.committedFacts,
        ...(fileChangeObservation ? { fileChangeObservation } : {}),
        ...(confirmedCandidates.length > 0
            ? { backgroundTaskReadCandidates: confirmedCandidates }
            : {}),
    };
    return { ...outcome, committedFacts };
}
export function attachWaitingForUser(outcome, waitingForUser) {
    return waitingForUser && outcome.status === 'completed'
        ? { ...outcome, waitingForUser: true }
        : outcome;
}
export function continuationRunMode(input) {
    return input.request.executionMode === 'continuation' ? { startMode: 'continue' } : {};
}
export function providerHistory(input) {
    return (input.runnerHistory ?? input.history).messages;
}
export function ackCommittedToolResultTailClaims(messages, pendingClaims, input) {
    messages.forEach((message) => {
        if (message.role !== 'toolResult' || !pendingClaims.has(message.toolCallId))
            return;
        input.control.ackToolResultTail(message.toolCallId);
        pendingClaims.delete(message.toolCallId);
    });
}
//# sourceMappingURL=turn-execution-policy.js.map