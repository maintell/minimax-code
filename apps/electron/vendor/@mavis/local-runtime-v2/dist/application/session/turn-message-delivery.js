import { isAbandonedStreamClosingMessage, MsgType, Role } from '@mavis/agent-core/protocol';
import { queryCollapseSteeringProjection, } from '../conversation/index.js';
import { sessionClioQueuedQueryId } from '../../service/session-clio/index.js';
/**
 * Turn-system message delivery adapters split out of `services.ts` to keep that
 * composition root inside the local-runtime layout budget. Composition wiring
 * stays in `services.ts`; only the adapter bodies live here.
 */
export function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
export function createQueueWakeFailureReporter(reportFailure, prefix) {
    return ({ sessionId, error }) => {
        reportFailure?.(sessionId, `${prefix}:${describeError(error)}`);
    };
}
function clientRequestFields(input) {
    return {
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
        ...(input.receiptAliases?.length ? { receiptAliases: input.receiptAliases } : {}),
    };
}
function activationDeliveryFields(delivery) {
    return {
        ...(delivery?.messageKey ? { messageKey: delivery.messageKey } : {}),
        propagateDeliveryFailure: delivery?.propagateDeliveryFailure,
        unstartedFromTurnIds: delivery?.unstartedFromTurnIds,
        beforeSubmit: delivery?.beforeSubmit,
        ...(delivery?.createdAt !== undefined ? { createdAt: delivery.createdAt } : {}),
        ...(delivery?.userMessageId ? { userMessageId: delivery.userMessageId } : {}),
        ...(delivery?.hideUserMessage ? { hideUserMessage: true } : {}),
        ...(delivery?.displayContent !== undefined ? { displayContent: delivery.displayContent } : {}),
        ...(delivery?.displayAttachments ? { displayAttachments: delivery.displayAttachments } : {}),
        ...(delivery?.onAccepted ? { onAccepted: delivery.onAccepted } : {}),
        ...(delivery?.beforeStart ? { beforeStart: delivery.beforeStart } : {}),
    };
}
export function createTurnSystemMessageDelivery(delivery) {
    return ({ execution }) => ({
        activation: {
            execute: (input) => delivery.deliver({
                sessionId: input.sessionId,
                input: input.input,
                immediateSendBatch: input.immediateSendBatch,
                provenance: input.provenance,
                ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
                ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
                // A re-routed submission carries the Query its producer already
                // admitted, so this Turn binds that Query instead of admitting the
                // same user text under a second id.
                ...(input.admittedQueryId ? { admittedQueryId: input.admittedQueryId } : {}),
                ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
                ...activationDeliveryFields(input.delivery),
                submit: ({ requestedTurnId, executionStart, genuineUserQueryText, requiresInputReview, }) => execution.execute({
                    sessionId: input.sessionId,
                    input: input.input,
                    immediateSendBatch: input.immediateSendBatch,
                    ...executionOptionsFields(input),
                    genuineUserQueryText,
                    ...(input.inputSafetyDecision
                        ? { inputSafetyDecision: input.inputSafetyDecision }
                        : {}),
                    requiresInputReview,
                    provenance: input.provenance,
                    requestedTurnId,
                    executionStart,
                    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
                    ...((input.userMessageId ?? input.delivery?.userMessageId)
                        ? { userMessageId: input.userMessageId ?? input.delivery?.userMessageId }
                        : {}),
                    ...clientRequestFields(input),
                    ...(input.admissionPriority ? { admissionPriority: input.admissionPriority } : {}),
                    ...(input.resume ? { resume: input.resume } : {}),
                    ...(input.delivery?.preDelivery ? { preDelivery: input.delivery.preDelivery } : {}),
                }),
            }),
        },
        queue: {
            execute: (input) => {
                let deliveryTurnId;
                return delivery.deliver({
                    sessionId: input.sessionId,
                    input: input.input,
                    createdAt: input.candidateCreatedAtMs,
                    immediateSendBatch: input.immediateSendBatch,
                    provenance: input.ingress.provenance,
                    // The queued Query was admitted at enqueue; delivery only binds it to the
                    // Turn that actually consumed it, stamped with the real enqueue instant.
                    queryOccurredAtMs: input.candidateCreatedAtMs,
                    admittedQueryId: sessionClioQueuedQueryId(input.ingress.itemId),
                    propagateDeliveryFailure: true,
                    onAccepted: input.onAccepted,
                    unstartedFromTurnIds: input.unstartedFromTurnIds,
                    beforeSubmit: async (turnId) => {
                        deliveryTurnId = turnId;
                        await input.beforeSubmit?.(turnId);
                    },
                    beforeStart: async () => {
                        await input.beforeStart?.(deliveryTurnId);
                    },
                    ...(input.ingress.provenance.source === 'api' ||
                        input.ingress.provenance.source === 'code_review'
                        ? { sourceMessageId: input.ingress.itemId }
                        : {}),
                    ...(input.requestedTurnId ? { requestedTurnId: input.requestedTurnId } : {}),
                    ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
                    ...(input.hideUserMessage ? { hideUserMessage: true } : {}),
                    ...(input.displayContent !== undefined ? { displayContent: input.displayContent } : {}),
                    ...(input.displayAttachments ? { displayAttachments: input.displayAttachments } : {}),
                    ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
                    submit: ({ requestedTurnId, executionStart, genuineUserQueryText, requiresInputReview, }) => execution.execute({
                        sessionId: input.sessionId,
                        input: input.input,
                        immediateSendBatch: input.immediateSendBatch,
                        genuineUserQueryText,
                        ...(input.inputSafetyDecision
                            ? { inputSafetyDecision: input.inputSafetyDecision }
                            : {}),
                        requiresInputReview,
                        ingress: input.ingress,
                        ...(input.queueSelection ? { queueSelection: input.queueSelection } : {}),
                        // GOAL-05: the rows that yielded their FIFO position for this
                        // claim have to reach the admitting transaction, or the priority
                        // fence re-blocks the claim on the row selection just skipped.
                        ...(input.yieldedQueueItemIds && input.yieldedQueueItemIds.length > 0
                            ? { yieldedQueueItemIds: input.yieldedQueueItemIds }
                            : {}),
                        candidateCreatedAtMs: input.candidateCreatedAtMs,
                        requestedTurnId,
                        executionStart,
                        ...(input.clientIntent ? { clientIntent: input.clientIntent } : {}),
                        ...((input.userMessageId ?? input.ingress.userMessageId)
                            ? { userMessageId: input.userMessageId ?? input.ingress.userMessageId }
                            : {}),
                    }),
                });
            },
        },
    });
}
function executionOptionsFields(input) {
    return {
        ...(input.outputContract ? { outputContract: input.outputContract } : {}),
        ...(input.executionDeadlineAtMs !== undefined
            ? { executionDeadlineAtMs: input.executionDeadlineAtMs }
            : {}),
    };
}
export function createConsumedSteeringHandler(delivery, sessions, publish, reportFailure) {
    return async (input) => {
        await delivery.consumeSteering(input);
        await publishConsumedSteeringStart({ input, sessions, publish, reportFailure });
    };
}
export function createApprovedTitleHandler(sessions, reportFailure) {
    return (input) => generateTitleAfterApprovedInputReview({ ...input, sessions, reportFailure });
}
const detachedTitleResolutions = new WeakSet();
function generateTitleAfterApprovedInputReview(input) {
    if (input.rejected)
        return;
    detachedTitleResolutions.add(generateTitleFromCommittedUserMessage(input));
}
async function generateTitleFromCommittedUserMessage(input) {
    try {
        const messages = await input.sessions.messages.repository.listTurn(input.sessionId, input.turnId);
        const userMessage = messages.find((message) => message.role === Role.User);
        if (!userMessage || typeof userMessage.msg_content !== 'string' || !userMessage.msg_content)
            return;
        input.sessions.titles.generate(input.sessionId, userMessage.msg_content);
    }
    catch (error) {
        try {
            input.reportFailure?.(input.sessionId, `session_title_source_resolution_failed:${describeError(error)}`);
        }
        catch {
            // Detached title diagnostics cannot change the owning Turn.
        }
    }
}
async function publishConsumedSteeringStart(input) {
    try {
        const session = await input.sessions.sessions.repository.get(input.input.sessionId);
        if (!session)
            throw new Error(`Consumed steer Session not found: ${input.input.sessionId}`);
        input.publish({
            type: 'session.start',
            payload: {
                sessionId: input.input.sessionId,
                agentName: session.agentName,
                turnId: input.input.turnId,
                ...(consumedBackgroundTaskDeliveryIdentity(input.input.message) ?? {}),
            },
        });
    }
    catch (error) {
        input.reportFailure?.(input.input.sessionId, `steer_session_start_publish_failed:${describeError(error)}`);
    }
}
function consumedBackgroundTaskDeliveryIdentity(message) {
    if (message.producerId !== 'background-task-delivery')
        return undefined;
    const taskId = message.idempotencyKey.trim();
    return taskId ? { source: 'background-task-delivery', taskId } : undefined;
}
export function reportRootBestEffortFailure(reportFailure, input) {
    const stage = input.stage === 'turn-abort' ? 'abort' : input.stage.replaceAll('-', '_');
    reportFailure?.(input.sessionId, `root_replacement_${stage}_failed:${describeError(input.error)}`);
}
/**
 * Feeds the title review: the logical query of the committed reply, including continuation
 * steering, with the runner's exact final reply; or, for a Session still being named, its first
 * request whichever later reply triggered the attempt.
 */
export function createReplyTitleReviewHandler(sessions, reportFailure) {
    const repository = sessions.messages.repository;
    return (input) => {
        detachedTitleResolutions.add((async () => {
            try {
                await sessions.titleReviews.review({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    loadContent: async (request) => {
                        const reply = await readReplyRequest(repository, input);
                        if (request.scope === 'first-request') {
                            return readFirstRequest(repository, input, request.session, reply);
                        }
                        return reply && { userInputs: reply.userInputs, finalReply: reply.finalReply };
                    },
                });
            }
            catch (error) {
                try {
                    reportFailure?.(input.sessionId, `session_title_review_source_failed:${describeError(error)}`);
                }
                catch {
                    /* Best-effort diagnostics. */
                }
            }
        })());
    };
}
async function readReplyRequest(repository, input) {
    const messages = await repository.listTurn(input.sessionId, input.turnId);
    const reply = messages.find((message) => message.msg_id === input.replyMessageId && message.role === Role.Assistant);
    if (typeof reply?.msg_content !== 'string' || !reply.msg_content.trim())
        return null;
    const queryRootKey = rootQueryKey(reply.query_key);
    const request = { ...(queryRootKey ? { queryRootKey } : {}), turnId: input.turnId };
    const inputs = await readRequestRows(repository, input.sessionId, request, {
        role: 'user',
        before: input.replyMessageId,
        turnRows: messages,
    });
    return { userInputs: userTexts(inputs), finalReply: reply.msg_content, request };
}
/**
 * The Session's own first request, after any inherited SideChat prefix. The committed reply is
 * used as is when it answers that request; otherwise the request's final reply is read from
 * history on every attempt, so a first request that was rewound or continued is read as it is
 * now. A first request that ended without a final reply contributes its user inputs only.
 */
async function readFirstRequest(repository, input, session, reply) {
    const boundary = session.sideChatOrigin?.inheritedThroughMessageId;
    const first = await repository.findFirstUserMessage(input.sessionId, boundary ? { afterMessageId: boundary } : undefined);
    if (!first)
        return null;
    const request = requestOf(first);
    if (reply && sameRequest(reply.request, request)) {
        return { userInputs: reply.userInputs, finalReply: reply.finalReply };
    }
    const finalReply = await findRequestReply(repository, input.sessionId, request);
    const inputs = request.queryRootKey || request.turnId
        ? await readRequestRows(repository, input.sessionId, request, {
            role: 'user',
            ...(finalReply?.msg_id ? { before: finalReply.msg_id } : {}),
        })
        : [first];
    return {
        userInputs: userTexts(inputs),
        finalReply: typeof finalReply?.msg_content === 'string' ? finalReply.msg_content : '',
    };
}
function requestOf(message) {
    const queryRootKey = rootQueryKey(message.query_key);
    return {
        ...(queryRootKey ? { queryRootKey } : {}),
        ...(message.turnId ? { turnId: message.turnId } : {}),
    };
}
function sameRequest(left, right) {
    if (right.queryRootKey !== undefined && left.queryRootKey === right.queryRootKey)
        return true;
    return right.turnId !== undefined && left.turnId === right.turnId;
}
/** A request's rows of one role, oldest first, ending before `before` when it is given. */
async function readRequestRows(repository, sessionId, request, options) {
    const { role, before } = options;
    if (request.queryRootKey) {
        const page = await repository.list(sessionId, {
            role,
            queryRootKey: request.queryRootKey,
            ...(before ? { before } : {}),
        });
        return page.messages;
    }
    if (!request.turnId)
        return [];
    const turn = options.turnRows ?? (await repository.listTurn(sessionId, request.turnId));
    const end = before ? turn.findIndex((message) => message.msg_id === before) : -1;
    return (end < 0 ? turn : turn.slice(0, end)).filter((message) => message.role === role);
}
const NON_FINAL_FINISH_REASONS = new Set(['toolUse', 'tool_use', 'tool_calls', 'aborted', 'error']);
/**
 * A request's final reply read from history: its last assistant text, and only when that ended
 * normally. An interrupted, abandoned or failed request has no reply.
 */
async function findRequestReply(repository, sessionId, request) {
    const rows = await readRequestRows(repository, sessionId, request, { role: 'assistant' });
    const last = [...rows].reverse().find(isAssistantText);
    return last && endedNormally(last) ? last : undefined;
}
function isAssistantText(message) {
    return (message.role === Role.Assistant &&
        message.msg_type !== MsgType.SystemEvent &&
        typeof message.msg_content === 'string' &&
        message.msg_content.trim().length > 0);
}
function endedNormally(message) {
    if (message.msg_type === MsgType.AgentToolCall)
        return false;
    // A stream abandoned mid-answer leaves a half answer behind; it is not the request's reply.
    if (isAbandonedStreamClosingMessage(message))
        return false;
    const finish = message.finish_reason;
    return typeof finish !== 'string' || !NON_FINAL_FINISH_REASONS.has(finish);
}
function rootQueryKey(queryKey) {
    if (typeof queryKey !== 'string' || !queryKey)
        return undefined;
    return queryCollapseSteeringProjection(queryKey).root_query_key ?? queryKey;
}
function userTexts(messages) {
    return messages.flatMap((message) => message.role === Role.User && typeof message.msg_content === 'string'
        ? [message.msg_content]
        : []);
}
//# sourceMappingURL=turn-message-delivery.js.map