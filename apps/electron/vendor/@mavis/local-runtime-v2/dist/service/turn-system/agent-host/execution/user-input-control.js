import { toPiUserMessage, } from '@mavis/agent-core/pi-turn-runner';
import { emitLocalPluginHookWarnings, localPluginHookCoordinator as pluginHookCoordinator, renderPluginHookRejectionReminder, } from '../assembly/local-turn-plugin-hooks.js';
import { isHandedBackOnClose, isUserSteeringProducer } from '../runner/contracts.js';
import { AgentHostTurnCloseError } from '../runner/turn-close-error.js';
import { joinUserPrompt } from './prompt.js';
const MAX_PLUGIN_STOP_CONTINUATIONS = 8;
export function createContinuationControl(input, prepare, onConsumed) {
    const { control } = input;
    const hookFollowUps = [];
    const pluginStopState = { active: false, continuationCount: 0 };
    let stopAfterSteering = false;
    return {
        getSteeringMessages: async (context) => {
            const claims = control.drainSteering();
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
            // Deferred entries, a stopping prompt, and every item after it remain
            // unconsumed. Restore them in one FIFO claim ahead of newer arrivals.
            const restoreUnconsumed = () => {
                const accepted = new Set(messages.filter((_, index) => consumed.has(index)));
                const unconsumed = claims.filter((claim) => !(claim.batchMembers ?? [claim]).every((message) => accepted.has(message)));
                if (unconsumed.length > 0)
                    control.restoreSteering(unconsumed);
            };
            try {
                for (const [index, message] of messages.entries()) {
                    if (deferUserProducers &&
                        isHandedBackOnClose(message.producerId, context?.workClosed === true)) {
                        continue;
                    }
                    const result = await preparePluginSteeringMessage(input, message, prepare);
                    if (result.kind === 'stop') {
                        stopAfterSteering = true;
                        consumed.clear();
                        prepared.length = 0;
                        acceptedUserMessageIds.length = 0;
                        // The visible runtime warning explains why this turn stopped.
                        break;
                    }
                    consumed.add(index);
                    const memberBatchId = result.userBatchMember ? batchId : undefined;
                    prepared.push(markBatchMessage(result.message, memberBatchId, message.createdAt));
                    if (result.acceptedUserMessageId) {
                        acceptedUserMessageIds.push({
                            id: result.acceptedUserMessageId,
                            batchId: memberBatchId,
                        });
                    }
                }
                for (const index of consumed) {
                    await onConsumed?.({
                        sessionId: input.lease.sessionId,
                        turnId: input.lease.turnId,
                        message: messages[index],
                    });
                }
            }
            catch (error) {
                consumed.clear();
                restoreUnconsumed();
                throw error;
            }
            restoreUnconsumed();
            registerBatchIdentities(input, acceptedUserMessageIds);
            const accepted = new Set(messages.filter((_, index) => consumed.has(index)));
            const completeClaims = claims.filter((claim) => (claim.batchMembers ?? [claim]).every((message) => accepted.has(message)));
            if (completeClaims.length > 0)
                control.ackSteering(completeClaims);
            return [...hookFollowUps.splice(0), ...prepared];
        },
        shouldStopAfterSteering: () => stopAfterSteering,
        tryBeginClose: (closeContext) => {
            const closeOptions = {
                ...(closeContext.workClosed === true ? { workClosed: true } : {}),
                ...(closeContext.final === true ? { final: true } : {}),
            };
            const result = control.tryBeginClose(Object.keys(closeOptions).length > 0 ? closeOptions : undefined);
            if (result.closed) {
                // A final close follows a refused request: a Stop hook asking to
                // continue could not be honored, so the Turn just ends.
                if (input.pluginHooks?.length && closeContext.final !== true) {
                    return finishPluginStopAndTrack(input, hookFollowUps, closeContext, pluginStopState);
                }
                pluginHookCoordinator.completeTurn(input.lease.sessionId);
                return true;
            }
            if (result.reason === 'steer-pending')
                return false;
            throw new AgentHostTurnCloseError(result.reason, result.reason === 'aborted' ? result.abortReason : undefined);
        },
    };
}
async function finishPluginStopAndTrack(input, hookFollowUps, closeContext, state) {
    const closed = await finishPluginStop(input, hookFollowUps, {
        stopHookActive: state.active,
        stopContinuationCount: state.continuationCount,
        ...(closeContext.lastAssistantMessage
            ? { lastAssistantMessage: closeContext.lastAssistantMessage }
            : {}),
    });
    if (!closed) {
        state.active = true;
        state.continuationCount += 1;
    }
    return closed;
}
async function preparePluginSteeringMessage(input, message, prepare) {
    const hookResult = input.pluginHooks?.length
        ? await pluginHookCoordinator.runEvent(input.pluginHooks, {
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
async function finishPluginStop(input, hookFollowUps, context) {
    const result = await pluginHookCoordinator.finishTurn({
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
        pluginHookCoordinator.completeTurn(input.lease.sessionId);
        return true;
    }
    if (decision.continuePrompt) {
        // The Stop hook runs after the close was won, so continuing must reopen
        // the Turn first; otherwise every tool call in the continuation is
        // refused at the closed tool-result seam.
        if (context.stopContinuationCount >= MAX_PLUGIN_STOP_CONTINUATIONS ||
            !input.control.cancelClose()) {
            pluginHookCoordinator.completeTurn(input.lease.sessionId);
            return true;
        }
        hookFollowUps.push(toPiUserMessage({ text: decision.continuePrompt }));
        return false;
    }
    pluginHookCoordinator.completeTurn(input.lease.sessionId);
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
//# sourceMappingURL=user-input-control.js.map