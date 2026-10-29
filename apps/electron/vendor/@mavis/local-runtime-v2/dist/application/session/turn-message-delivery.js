import { Role } from '@mavis/agent-core/protocol';
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
//# sourceMappingURL=turn-message-delivery.js.map