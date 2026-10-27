import { logger } from '../../../infra/logging/index.js';
import { THREAD_GOAL_PAUSED_ABORT_REASON } from '../../turn-system/index.js';
import { detach } from './detach.js';
import { readThreadGoalContinuationOrigin, threadGoalContinuationClientRequestId, threadGoalRearmClientRequestId, } from '../continuation/kickoff.js';
/**
 * The Goal owner's four Turn-producing operations, expressed over the runtime
 * conversation ingress. Every Goal Turn is submitted with source `thread-goal`
 * and a hidden user message, so queue admission, the Goal binding and history
 * rendering all recognize it.
 */
export function createGoalConversationPorts(input) {
    const { conversation, promptReads } = input;
    return {
        startContinuationTurn: async (sessionId, message, displayContent, internalPromptRead) => {
            const clientRequestId = epochContinuationClientRequestId(message);
            try {
                const accepted = await conversation().ingress.submit({
                    sessionId,
                    source: 'thread-goal',
                    allowQueue: true,
                    ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
                    message: {
                        ...message,
                        hideUserMessage: true,
                        ...(displayContent ? { displayContent } : {}),
                    },
                    ...(clientRequestId ? { clientRequestId } : {}),
                });
                if (internalPromptRead && accepted.turnId !== internalPromptRead.requestedTurnId) {
                    // A different Turn id means the epoch key folded this start onto a
                    // continuation already queued or started; that Turn owns its prompt.
                    if (clientRequestId)
                        promptReads().discardInternalPromptRead(internalPromptRead);
                    else
                        promptReads().rebindInternalPromptRead(internalPromptRead, accepted.turnId);
                }
                return { status: 'started', turnId: accepted.turnId };
            }
            catch (error) {
                if (internalPromptRead)
                    promptReads().discardInternalPromptRead(internalPromptRead);
                throw error;
            }
        },
        steerContinuationTurn: async ({ sessionId, message, idempotencyKey, internalPromptRead, onAccepted, }) => {
            try {
                const result = await conversation().ingress.steer({
                    sessionId,
                    source: 'thread-goal',
                    producerId: 'thread-goal-objective',
                    idempotencyKey,
                    ...(internalPromptRead ? { requestedTurnId: internalPromptRead.requestedTurnId } : {}),
                    message: {
                        content: message.content,
                        attachments: message.attachments.map((attachment) => ({ ...attachment })),
                        origin: message.origin,
                        hideUserMessage: true,
                    },
                    preDelivery: {
                        accept: async (accepted) => {
                            if (internalPromptRead) {
                                if (accepted.mode === 'activated') {
                                    promptReads().rebindInternalPromptRead(internalPromptRead, accepted.turnId);
                                }
                                else {
                                    promptReads().discardInternalPromptRead(internalPromptRead);
                                }
                            }
                            await onAccepted(accepted);
                        },
                    },
                });
                if (result.mode === 'activated')
                    detach(observeActivatedSteer(sessionId, result));
                return result;
            }
            catch (error) {
                if (internalPromptRead)
                    promptReads().discardInternalPromptRead(internalPromptRead);
                throw error;
            }
        },
        enqueuePostTurnContinuation: async (continuation) => {
            try {
                const accepted = await conversation().ingress.submit({
                    sessionId: continuation.sessionId,
                    source: 'thread-goal',
                    allowQueue: true,
                    ...(continuation.internalPromptRead
                        ? { requestedTurnId: continuation.internalPromptRead.requestedTurnId }
                        : {}),
                    message: { ...continuation.message, hideUserMessage: true },
                    clientRequestId: continuation.clientRequestId ??
                        threadGoalContinuationClientRequestId(continuation.turnId),
                });
                if (continuation.internalPromptRead &&
                    accepted.turnId !== continuation.internalPromptRead.requestedTurnId) {
                    promptReads().rebindInternalPromptRead(continuation.internalPromptRead, accepted.turnId);
                }
                if (!accepted.queue) {
                    throw new Error(`Thread Goal continuation submit did not queue: ${continuation.sessionId}`);
                }
            }
            catch (error) {
                if (continuation.internalPromptRead) {
                    promptReads().discardInternalPromptRead(continuation.internalPromptRead);
                }
                throw error;
            }
        },
        abortThreadGoalTurn: (sessionId, turnId) => conversation().ingress.abort(sessionId, THREAD_GOAL_PAUSED_ABORT_REASON, turnId),
    };
}
/**
 * Key an `active` continuation by the Goal epoch it was built at.
 *
 * Every path that hands the Goal its next Turn at one epoch — a resume, a
 * repeated resume, the re-arm after a busy Turn settles — then folds onto one
 * Queue item and one Turn receipt, so racing starts cannot run the Goal twice.
 * A new epoch gets a new key and therefore a Turn of its own.
 */
function epochContinuationClientRequestId(message) {
    const origin = readThreadGoalContinuationOrigin(message.origin);
    if (!origin || origin.kind !== 'active')
        return undefined;
    return threadGoalRearmClientRequestId({ goalId: origin.goalId, updatedAt: origin.goalUpdatedAt });
}
async function observeActivatedSteer(sessionId, result) {
    try {
        await result.completion;
    }
    catch (error) {
        logger.warn({ sessionId, turnId: result.turnId }, `Thread Goal objective steering activated Turn failed after admission: ${error instanceof Error ? error.message : String(error)}`);
    }
}
//# sourceMappingURL=conversation-ports.js.map