import { toPiUserMessage, } from '@mavis/agent-core/pi-turn-runner';
import { emitLocalPluginHookWarnings, renderPluginHookRejectionReminder, } from '../assembly/local-turn-plugin-hooks.js';
import { createWakeLineMessage, resolveInputWakeReason } from '../preparation/turn-wake-reasons.js';
import { createRecallPointersMessage } from './turn-state-layer/state-delta-message.js';
import { isHandedBackOnClose, isUserSteeringProducer } from '../runner/contracts.js';
import { AgentHostTurnCloseError } from '../runner/turn-close-error.js';
import { joinUserPrompt } from './prompt.js';
const MAX_PLUGIN_STOP_CONTINUATIONS = 8;
/**
 * Wait for the Turn's own background shell only at a natural exit with
 * nothing else to run; never once the Turn's work is closed.
 */
export function waitsForChildBash(context, messageCount, continuation) {
    return (context?.boundary === 'exit' &&
        context.workClosed !== true &&
        messageCount === 0 &&
        !continuation.shouldStopAfterSteering?.());
}
export function createContinuationControl(input, prepare, onConsumed, options) {
    const { control } = input;
    const { coordinator } = options;
    const hookFollowUps = [];
    const pluginStopState = { coordinator, active: false, continuationCount: 0 };
    let stopAfterSteering = false;
    return {
        getSteeringMessages: async (context) => {
            const claims = await control.drainSteering();
            const messages = claims.flatMap((message) => message.batchMembers ?? [message]);
            // Exit-boundary rule (immediate-send-steering Decision v2): user
            // steering never extends a finished answer. It stays unconsumed so the
            // close that follows an empty poll requeues it as a fresh query, while
            // non-user producers keep injecting into the current turn.
            const deferUserProducers = context?.boundary === 'exit';
            const prepared = [];
            const batchId = snapshotBatchId(messages, input.lease.turnId);
            const acceptedUserMessageIds = [];
            const consumed = new Set();
            /** Indices a Plugin Hook replaced with its rejection reminder. */
            const hookDenied = new Set();
            // Deferred entries, a stopping prompt, and every item after it remain
            // unconsumed. Restore them in one FIFO claim ahead of newer arrivals.
            const restoreUnconsumed = async () => {
                const accepted = new Set(messages.filter((_, index) => consumed.has(index)));
                const unconsumed = claims.filter((claim) => !(claim.batchMembers ?? [claim]).every((message) => accepted.has(message)));
                if (unconsumed.length > 0)
                    await control.restoreSteering(unconsumed);
            };
            const wakeLines = createWakeLineWriter(options.wakeLineBeforeUserSteering === true, options.recallPointers);
            /**
             * One drained message of this poll. Resolves `true` when a Plugin Hook
             * stopped the Turn, which is where the old loop `break`ed; `false` is the
             * old `continue` and the ordinary path. Every branch, its order and its
             * side effects are unchanged — this only gives them their own frame.
             */
            const consumeOne = async (index, message) => {
                if (deferUserProducers &&
                    isHandedBackOnClose(message.producerId, context?.workClosed === true)) {
                    return false;
                }
                const result = await preparePluginSteeringMessage(input, message, prepare, coordinator);
                if (result.kind === 'stop') {
                    stopAfterSteering = true;
                    consumed.clear();
                    hookDenied.clear();
                    prepared.length = 0;
                    acceptedUserMessageIds.length = 0;
                    // The visible runtime warning explains why this turn stopped.
                    return true;
                }
                consumed.add(index);
                if (result.hookDenied === true)
                    hookDenied.add(index);
                prepared.push(...wakeLines.before(message, result));
                const memberBatchId = result.userBatchMember ? batchId : undefined;
                prepared.push(markBatchMessage(result.message, memberBatchId, message.createdAt));
                if (result.acceptedUserMessageId) {
                    acceptedUserMessageIds.push({
                        id: result.acceptedUserMessageId,
                        batchId: memberBatchId,
                    });
                }
                return false;
            };
            /** Report every consumed message in index order, once, after the pass. */
            const reportConsumed = async () => {
                for (const index of consumed) {
                    await onConsumed?.({
                        sessionId: input.lease.sessionId,
                        turnId: input.lease.turnId,
                        message: messages[index],
                        ...(hookDenied.has(index) ? { hookDenied: true } : {}),
                    });
                }
            };
            try {
                for (const [index, message] of messages.entries()) {
                    if (await consumeOne(index, message))
                        break;
                }
                await reportConsumed();
            }
            catch (error) {
                consumed.clear();
                hookDenied.clear();
                await restoreUnconsumed();
                throw error;
            }
            await restoreUnconsumed();
            registerBatchIdentities(input, acceptedUserMessageIds);
            notifyReplyInput(options.onAcceptedInput, consumed, messages, acceptedUserMessageIds);
            const accepted = new Set(messages.filter((_, index) => consumed.has(index)));
            const completeClaims = claims.filter((claim) => (claim.batchMembers ?? [claim]).every((message) => accepted.has(message)));
            if (completeClaims.length > 0)
                await control.ackSteering(completeClaims);
            return [...hookFollowUps.splice(0), ...prepared];
        },
        shouldStopAfterSteering: () => stopAfterSteering,
        tryBeginClose: async (closeContext) => {
            const closeOptions = {
                ...(closeContext.workClosed === true ? { workClosed: true } : {}),
                ...(closeContext.final === true ? { final: true } : {}),
            };
            const result = await control.tryBeginClose(Object.keys(closeOptions).length > 0 ? closeOptions : undefined);
            if (result.closed) {
                // A final close follows a refused request: a Stop hook asking to
                // continue could not be honored, so the Turn just ends.
                if (input.pluginHooks?.length && closeContext.final !== true) {
                    return finishPluginStopAndTrack(input, hookFollowUps, closeContext, pluginStopState);
                }
                coordinator.completeTurn(input.lease.sessionId);
                return true;
            }
            if (result.reason === 'steer-pending')
                return false;
            throw new AgentHostTurnCloseError(result.reason, result.reason === 'aborted' ? result.abortReason : undefined);
        },
    };
}
function createWakeLineWriter(enabled, recallPointers) {
    let previousUserSteer = false;
    return {
        before(message, result) {
            const fromUser = result.hookDenied !== true &&
                resolveInputWakeReason({
                    provenance: message.provenance,
                    origin: message.message.origin,
                }) === 'user';
            const userSteer = enabled && fromUser;
            const first = userSteer && !previousUserSteer;
            previousUserSteer = userSteer;
            const timestamp = message.createdAt ?? Date.now();
            const pointers = fromUser
                ? recallPointersOf(recallPointers, {
                    userText: message.genuineUserQueryText,
                    currentMessageIds: message.userMessageId ? [message.userMessageId] : [],
                })
                : '';
            return [
                ...(first ? [createWakeLineMessage(['user'], timestamp)] : []),
                ...(pointers ? [createRecallPointersMessage(pointers, timestamp)] : []),
            ];
        },
    };
}
/** A failed lookup never holds up the steered message. */
function recallPointersOf(recallPointers, steered) {
    if (!recallPointers || !steered.userText.trim())
        return '';
    try {
        return recallPointers(steered);
    }
    catch {
        return '';
    }
}
async function finishPluginStopAndTrack(input, hookFollowUps, closeContext, state) {
    const closed = await finishPluginStop(input, hookFollowUps, {
        stopHookActive: state.active,
        stopContinuationCount: state.continuationCount,
        ...(closeContext.lastAssistantMessage
            ? { lastAssistantMessage: closeContext.lastAssistantMessage }
            : {}),
    }, state.coordinator);
    if (!closed) {
        state.active = true;
        state.continuationCount += 1;
    }
    return closed;
}
async function preparePluginSteeringMessage(input, message, prepare, coordinator) {
    const hookResult = input.pluginHooks?.length
        ? await coordinator.runEvent(input.pluginHooks, {
            event: 'UserPromptSubmit',
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            cwd: input.session.workspaceDir,
            ...input.pluginHookRuntimeContext,
            payload: { prompt: message.message.text, source: 'steer' },
        }, input.lease.signal)
        : undefined;
    if (hookResult) {
        await emitLocalPluginHookWarnings({
            reporter: input.pluginHookEventReporter,
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            event: 'UserPromptSubmit',
            result: hookResult,
            ...(hookResult.decision.continue === false
                ? {
                    message: hookResult.decision.stopReason ??
                        hookResult.decision.reason ??
                        'Queued prompt stopped by Plugin Hook.',
                }
                : {}),
        });
    }
    if (hookResult?.decision.continue === false) {
        return { kind: 'stop' };
    }
    if (hookResult?.decision.decision === 'deny') {
        return {
            kind: 'continue',
            message: toPiUserMessage({
                text: renderPluginHookRejectionReminder(hookResult.decision.reason),
            }),
            userBatchMember: false,
            hookDenied: true,
            acceptedUserMessageId: undefined,
        };
    }
    const piMessage = await prepareAcceptedPluginSteeringMessage(message, prepare, hookResult?.decision.additionalContext);
    return {
        kind: 'continue',
        message: piMessage,
        userBatchMember: isUserSteeringProducer(message.producerId),
        acceptedUserMessageId: message.userMessageId,
    };
}
async function prepareAcceptedPluginSteeringMessage(message, prepare, additionalContext) {
    const prepared = await prepare(message);
    return toPiUserMessage(appendPluginHookContext(withGenuineQueryProvenance(prepared.userMessage, prepared.genuineUserQueryText), additionalContext));
}
function appendPluginHookContext(message, additionalContext) {
    if (!additionalContext)
        return message;
    return {
        ...message,
        text: `${message.text}\n\n<plugin-hook-context>\n${additionalContext}\n</plugin-hook-context>`,
    };
}
async function finishPluginStop(input, hookFollowUps, context, coordinator) {
    const result = await coordinator.finishTurn({
        handlers: input.pluginHooks ?? [],
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        cwd: input.session.workspaceDir,
        ...input.pluginHookRuntimeContext,
        stopHookActive: context.stopHookActive,
        ...(context.lastAssistantMessage ? { lastAssistantMessage: context.lastAssistantMessage } : {}),
        signal: input.lease.signal,
    });
    await emitLocalPluginHookWarnings({
        reporter: input.pluginHookEventReporter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        event: input.session.parentSessionId ? 'SubagentStop' : 'Stop',
        result,
    });
    const decision = result.decision;
    if (decision.continue === false) {
        coordinator.completeTurn(input.lease.sessionId);
        return true;
    }
    if (decision.continuePrompt) {
        // The Stop hook runs after the close was won, so continuing must reopen
        // the Turn first; otherwise every tool call in the continuation is
        // refused at the closed tool-result seam.
        if (context.stopContinuationCount >= MAX_PLUGIN_STOP_CONTINUATIONS ||
            !(await input.control.cancelClose())) {
            coordinator.completeTurn(input.lease.sessionId);
            return true;
        }
        hookFollowUps.push(toPiUserMessage({ text: decision.continuePrompt }));
        return false;
    }
    coordinator.completeTurn(input.lease.sessionId);
    return true;
}
function markBatchMessage(message, batchId, timestamp) {
    return {
        ...message,
        ...(batchId ? { hostMetadata: { immediateSendBatchId: batchId } } : {}),
        ...(timestamp !== undefined ? { timestamp } : {}),
    };
}
function snapshotBatchId(messages, turnId) {
    const first = messages.find((message) => isUserSteeringProducer(message.producerId));
    return first ? `${turnId}:${first.producerId}:${first.idempotencyKey}` : undefined;
}
function registerBatchIdentities(input, identities) {
    for (const identity of identities) {
        if (identity.batchId)
            input.registerCanonicalUserMessageIds([identity.id], identity.batchId);
        else
            input.registerCanonicalUserMessageIds([identity.id]);
    }
}
export function prepareInitialImmediateSendBatch(input, preparedBatch, ordinary, prefix) {
    const batch = input.request.immediateSendBatch;
    if (!batch)
        return [ordinary];
    const { messages: preparedMessages, genuineUserQueryTexts: preparedGenuineUserQueryTexts } = preparedBatch;
    if (!preparedMessages || preparedMessages.length !== batch.members.length) {
        throw new TypeError('Initial batch preparation is incomplete.');
    }
    if (preparedGenuineUserQueryTexts !== undefined &&
        preparedGenuineUserQueryTexts.length !== batch.members.length) {
        throw new TypeError('Initial batch genuine-user provenance is incomplete.');
    }
    return batch.members.map((member, index) => {
        const prepared = preparedMessages[index];
        return withGenuineQueryProvenance({
            ...prepared,
            text: index === 0 ? joinUserPrompt(prefix, '', '', prepared.text) : prepared.text,
            timestamp: member.createdAt,
            hostMetadata: { ...prepared.hostMetadata, immediateSendBatchId: batch.id },
        }, preparedGenuineUserQueryTexts?.[index] ?? member.genuineUserQueryText);
    });
}
export function withGenuineQueryProvenance(input, genuineUserQueryText) {
    const startOffset = locateGenuineQuery(input.text, genuineUserQueryText);
    if (startOffset !== undefined) {
        return {
            ...input,
            canonicalTextRange: { startOffset, endOffset: startOffset + genuineUserQueryText.length },
        };
    }
    return {
        ...input,
        canonicalTextRange: { startOffset: input.text.length, endOffset: input.text.length },
        genuineUserQueryText,
    };
}
/**
 * The assembled text appends reminders and, for a peer message, wraps the body
 * in an envelope, so the original query is no longer a suffix. A trailing
 * match still wins, which keeps a reminder that repeats the query from moving
 * the range; otherwise the single interior occurrence is used. Repeated
 * occurrences stay unresolved and fall back to the stored query text. An
 * empty query always matches at the end, as it did before the envelope.
 */
function locateGenuineQuery(text, query) {
    const trailing = text.length - query.length;
    if (trailing >= 0 && text.slice(trailing) === query)
        return trailing;
    const first = text.indexOf(query);
    if (first < 0 || text.indexOf(query, first + 1) >= 0)
        return undefined;
    return first;
}
/** Pending child Bash keeps the Turn active, so user input must not be deferred to a future Turn. */
export async function resolveChildBashSteeringContext(context, childBash) {
    if (context?.boundary === 'exit' && !context.workClosed && (await childBash?.hasPending())) {
        return { boundary: 'mid-turn' };
    }
    return context;
}
function notifyReplyInput(notify, consumed, messages, accepted) {
    if (!notify || !consumed.size)
        return;
    const [index] = consumed;
    notify(consumed.size === 1 && accepted.length === 1 ? messages[index] : undefined);
}
/** The Turn's user steering as seen by `interruptOnSteer` tools; absent without a probe. */
export function userSteeringToolContext(control) {
    const { hasPendingUserSteering, steeringSignal } = control;
    if (!hasPendingUserSteering)
        return {};
    return {
        userSteering: {
            pending: () => hasPendingUserSteering(),
            changed: () => steeringSignal?.(),
        },
    };
}
export function preparePlainSteering(input) {
    return Promise.resolve({
        userMessage: { text: input.message.text },
        genuineUserQueryText: input.genuineUserQueryText,
    });
}
//# sourceMappingURL=user-input-control.js.map