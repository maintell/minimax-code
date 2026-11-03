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
    const managedProvider = input.preparation.llm.managedProvider === true;
    if (options.tuiProductPolicy === true) {
        const contentReviewRequired = options.contentReviewEnabled !== false && managedProvider;
        return {
            contentReviewRequired,
            ...(contentReviewRequired ? {} : { streamUnreviewedOutput: true }),
        };
    }
    if (options.cliProductPolicy === true)
        return { contentReviewRequired: managedProvider };
    // Desktop：BYOK（含自定义 Provider、Codex OAuth）不送 MiniMax 内容审核，输出直接流式下发；
    // 托管模型保持原有审核归属。
    return managedProvider ? {} : { contentReviewRequired: false, streamUnreviewedOutput: true };
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
/**
 * Maps the neutral runner's optional reconcile signal onto a host reconcile
 * intent. The concrete detection lives in the v2 native runner adapter; the
 * host only normalizes the approved partial content to a string.
 */
export function reconcileIntent(result) {
    const signal = result?.reconcile;
    if (!signal)
        return undefined;
    switch (signal.kind) {
        case 'output-recall':
            return {
                kind: 'output-recall',
                source: signal.source,
                variant: signal.variant,
                ...(signal.slowNetworkRead ? { slowNetworkRead: true } : {}),
            };
        case 'network-reconcile':
            return {
                kind: 'network-reconcile',
                approvedContent: signal.approvedContent ?? '',
                ...(signal.slowNetworkRead ? { slowNetworkRead: true } : {}),
            };
        case 'safety-reconcile':
            return { kind: 'safety-reconcile', approvedContent: signal.approvedContent };
        case 'abort-reconcile':
            return { kind: 'abort-reconcile', approvedContent: signal.approvedContent ?? '' };
        default:
            return undefined;
    }
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