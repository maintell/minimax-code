import { isUserTypedTurn } from '../preparation/turn-wake-reasons.js';
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
/**
 * Whether a model's traffic goes to content review: managed models only, narrowed by the product
 * policy. It decides a Turn's input and output review, and the advisor's input and advice review
 * by the advisor's own model. Prompt suggestions and archive titles still apply their own
 * managed-only check.
 */
export function isModelOutputReviewed(managedProvider, policy) {
    return (managedProvider && !(policy.tuiProductPolicy === true && policy.contentReviewEnabled === false));
}
export function contentReviewOptions(input, options) {
    const reviewed = isModelOutputReviewed(input.preparation.llm.managedProvider === true, options);
    if (options.tuiProductPolicy === true) {
        return {
            contentReviewRequired: reviewed,
            ...(reviewed ? {} : { streamUnreviewedOutput: true }),
        };
    }
    if (options.cliProductPolicy === true)
        return { contentReviewRequired: reviewed };
    // Desktop：BYOK（含自定义 Provider、Codex OAuth）不送 MiniMax 内容审核，输出直接流式下发；
    // 托管模型保持原有审核归属。
    return reviewed ? {} : { contentReviewRequired: false, streamUnreviewedOutput: true };
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
export function attachCommittedFacts(outcome, fileChangeObservation, backgroundTaskReadCandidates, savedPtcScripts = new Map()) {
    const confirmedCandidates = outcome.status === 'completed' ? [...backgroundTaskReadCandidates] : [];
    // Saved scripts are already on disk, so a failed or aborted Turn reports them too.
    const savedScripts = [...savedPtcScripts.values()];
    if (!fileChangeObservation && confirmedCandidates.length === 0 && savedScripts.length === 0) {
        return outcome;
    }
    const committedFacts = {
        ...outcome.committedFacts,
        ...(fileChangeObservation ? { fileChangeObservation } : {}),
        ...(confirmedCandidates.length > 0
            ? { backgroundTaskReadCandidates: confirmedCandidates }
            : {}),
        ...(savedScripts.length > 0 ? { savedPtcScripts: savedScripts } : {}),
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
                ...slowNetworkReadField(signal),
            };
        case 'network-reconcile':
            return {
                kind: 'network-reconcile',
                approvedContent: signal.approvedContent ?? '',
                ...slowNetworkReadField(signal),
            };
        case 'safety-reconcile':
            return { kind: 'safety-reconcile', approvedContent: signal.approvedContent };
        case 'abort-reconcile':
            return { kind: 'abort-reconcile', approvedContent: signal.approvedContent ?? '' };
        case 'reply-reconcile':
            return { kind: 'reply-reconcile' };
        default:
            return undefined;
    }
}
function slowNetworkReadField(signal) {
    return signal.slowNetworkRead ? { slowNetworkRead: true } : {};
}
/**
 * 本轮的触发输入全部由用户在本机给出时告诉 runner；网关模式下输出被打回、撤完什么都不剩时，
 * 只有这样的轮次才整轮撤回。
 */
export function userTypedTurnField(input) {
    return isUserTypedTurn(input.request) ? { userTypedTurn: true } : {};
}
export function continuationRunMode(input) {
    if (input.request.executionMode !== 'continuation')
        return {};
    return input.request.continuation?.resumeFrom === 'pending-tool-calls'
        ? { startMode: 'resume-tool-calls' }
        : { startMode: 'continue' };
}
/** Yield wiring the runner forwards to Pi; absent unless the run can yield. */
export function turnYieldRunOptions(input) {
    return {
        ...(input.isYieldStopped ? { isYieldStopped: input.isYieldStopped } : {}),
        ...(input.resumeAssistantMessageId
            ? { resumeAssistantMessageId: input.resumeAssistantMessageId }
            : {}),
    };
}
export function providerHistory(input) {
    return (input.runnerHistory ?? input.history).messages;
}
export async function ackCommittedToolResultTailClaims(messages, pendingClaims, input) {
    for (const message of messages) {
        if (message.role !== 'toolResult' || !pendingClaims.has(message.toolCallId))
            continue;
        await input.control.ackToolResultTail(message.toolCallId);
        pendingClaims.delete(message.toolCallId);
    }
}
/** The first `beforeLlmCall` hook input of a Turn, before any provider request is built. */
export function createInitialHookInput(input) {
    const { llm } = input;
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        phase: 'initial',
        messages: input.canonicalMessages,
        canonicalMessages: input.canonicalMessages,
        model: llm.model,
        ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }),
        ...(llm.headers === undefined ? {} : { headers: llm.headers }),
        ...(llm.maxTokens === undefined ? {} : { maxTokens: llm.maxTokens }),
        ...(llm.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: llm.maxSerializedInputBytes }),
        systemPrompt: input.systemPrompt,
        tools: input.tools.map((tool) => ({
            name: tool.def.name,
            description: tool.def.description,
            parameters: tool.def.schema,
        })),
        thinkingLevel: llm.thinkingLevel ?? 'off',
        signal: input.signal,
        eventWriter: input.eventWriter,
    };
}
/** Ends the `preparing` stage right before the runner takes the turn. */
export function preparedTurnTiming(timing, nowMs = Date.now) {
    return timing ? { turnTiming: { ...timing, preparedAtMs: nowMs() } } : {};
}
export function describeUnknownError(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    }
    catch {
        return 'unknown error';
    }
}
//# sourceMappingURL=turn-execution-policy.js.map