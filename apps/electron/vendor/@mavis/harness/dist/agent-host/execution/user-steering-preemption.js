import { buildRuntimeWarningEvent, buildStreamRespEvent } from '@mavis/agent-core/event-bridge';
import { createLLMCallPreemption, } from '@mavis/agent-core/pi-turn-runner';
import { MsgType, RespDataType } from '@mavis/agent-core/protocol';
import { isTrustedCoordinatorTurn } from '../assembly/payload/local-turn-payload-transform.js';
import { isUserSourcedWakeReason, resolveInputWakeReason, resolveTurnWakeReasons, } from '../preparation/turn-wake-reasons.js';
import { showsSendToUserText } from '../runner/output/send-to-user-display-projection.js';
/** @internal `runtime.warning` code of the receipt shown when a preemption could not be requested. */
export const USER_STEERING_QUEUED_CODE = 'USER_STEERING_QUEUED';
const USER_STEERING_QUEUED_MESSAGE = '已收到，会在当前这一步完成后处理。';
/** System event that removes the streamed part of a discarded response from display. */
const ASSISTANT_RESPONSE_DISCARDED_EVENT_TYPE = 'assistant.response_discarded';
/** Receipts written after their preemption attempt returned; tracked, never awaited. */
const detachedReceipts = new WeakSet();
/** Bunny's own main conversation: the trusted coordinator, not a child task Session. */
export function isBunnyMainConversationTurn(input) {
    return isTrustedCoordinatorTurn(input) && !input.session.parentSessionId;
}
/**
 * Bunny's main conversation answers a user who types while it is generating
 * without waiting for that generation to end: on each admitted user steering
 * the provider call in flight is cancelled and resent with the new message.
 * A running tool is never interrupted; its steering joins the next call as
 * before. Machine steering (task reports, schedules, background completions,
 * peers) never preempts, and other Agents and child task Sessions do not opt in.
 *
 * When cancelling or preparing the resend fails the steering stays queued as
 * before and the user gets an immediate receipt instead.
 */
export function startUserSteeringPreemption(input, logger, 
/**
 * Side events must share the running attempt's safety writer: they take their
 * runtime sequence from the same counter as Pi's output, so writing them
 * straight to the Turn writer would deliver a newer sequence ahead of an
 * older event still held for review.
 */
sideEvents) {
    if (!isBunnyMainConversationTurn(input))
        return undefined;
    const { control } = input;
    const steeringSignal = control.steeringSignal;
    const hasPendingUserSteering = control.hasPendingUserSteering;
    if (!steeringSignal || !hasPendingUserSteering)
        return undefined;
    const { sessionId, turnId } = input.lease;
    const reporter = input.pluginHookEventReporter;
    const log = { session_id: sessionId, turn_id: turnId };
    const append = async (event) => {
        if (sideEvents)
            return sideEvents.appendEvents([event]);
        await reporter?.appendEvents([event]);
    };
    const notifyQueued = async () => {
        if (!reporter)
            return;
        try {
            await append(buildRuntimeWarningEvent({
                sessionId,
                turnId,
                eventId: reporter.nextEventId('runtime_warning'),
                runtimeSeq: reporter.nextRuntimeSeq(),
                source: 'user-steering',
                category: 'notice',
                code: USER_STEERING_QUEUED_CODE,
                message: USER_STEERING_QUEUED_MESSAGE,
            }));
        }
        catch (error) {
            logger?.warn?.({ ...log, error: errorMessage(error) }, '[user-steering] queued receipt failed');
        }
    };
    const wakeReasons = new Set(resolveTurnWakeReasons(input.request));
    let latestUserWords = startingUserWords(input.request);
    const llmPreemption = createLLMCallPreemption({
        onResendFallback: notifyQueued,
        wakeReasons: () => [...wakeReasons],
        interruptedUserMessage: () => latestUserWords,
        deliversOnToolStart: showsSendToUserText,
        ...(reporter
            ? {
                onResponseDiscarded: (messageId) => {
                    // The voided response may still hold unreleased text in review.
                    sideEvents?.discardPendingMessage(messageId);
                    return append(responseDiscardedEvent(reporter, sessionId, turnId, messageId));
                },
            }
            : {}),
    });
    const preempt = () => {
        try {
            const result = llmPreemption.request();
            logger?.info?.({ ...log, result }, '[user-steering] preemption requested');
            input.steeringPreemptionObserver?.({ sessionId, turnId }, result);
        }
        catch (error) {
            input.steeringPreemptionObserver?.({ sessionId, turnId }, 'failed');
            logger?.warn?.({ ...log, error: errorMessage(error) }, '[user-steering] preemption failed; steering stays queued');
            // Detached like compaction observations: notifyQueued catches and logs its own failure.
            detachedReceipts.add(notifyQueued());
        }
    };
    let closed = false;
    let watched;
    const watch = () => {
        const signal = steeringSignal();
        if (!signal || signal.aborted)
            return;
        watched = signal;
        signal.addEventListener('abort', onSteering, { once: true });
    };
    // The controller replaces its wake signal on every admission: re-subscribe each time.
    function onSteering() {
        watched = undefined;
        if (closed)
            return;
        if (hasPendingUserSteering?.() === true)
            preempt();
        watch();
    }
    watch();
    return {
        llmPreemption,
        recordConsumedSteering: (item, options) => {
            const reason = resolveInputWakeReason({
                provenance: item.provenance,
                origin: item.message.origin,
            });
            if (reason)
                wakeReasons.add(reason);
            // A Plugin Hook replaced this message with its rejection reminder, so the model never
            // read the words: they must not come back to it through the preemption notice.
            if (options?.hookDenied !== true && isUserSourcedWakeReason(reason))
                latestUserWords = steeringUserWords(item);
        },
        close: () => {
            closed = true;
            watched?.removeEventListener('abort', onSteering);
            watched = undefined;
        },
    };
}
/** What the person typed to start the Turn; undefined when a system event started it. */
function startingUserWords(request) {
    const members = request.immediateSendBatch?.members ?? [];
    if (members.length > 0) {
        return joinWords(members
            .filter((member) => isUserSourcedWakeReason(resolveInputWakeReason({ provenance: member.provenance })))
            .map((member) => member.genuineUserQueryText));
    }
    const reason = resolveInputWakeReason({
        provenance: request.provenance ?? { source: '' },
        origin: request.input?.origin,
    });
    return isUserSourcedWakeReason(reason) ? joinWords([request.genuineUserQueryText]) : undefined;
}
/** A steered user message's words; a batch keeps each member's words in order. */
function steeringUserWords(item) {
    const members = item.batchMembers?.length ? item.batchMembers : [item];
    return joinWords(members.map((member) => member.genuineUserQueryText));
}
function joinWords(parts) {
    const text = parts
        .map((part) => part?.trim() ?? '')
        .filter(Boolean)
        .join('\n\n');
    return text || undefined;
}
/** The runner option that enables a Turn's preemption; empty when it is off. */
export function preemptionRunOption(preemption) {
    return preemption ? { llmPreemption: preemption.llmPreemption } : {};
}
/** The execution input that reports each answer; latency checkpoints never fail a Turn. */
export function preemptionObserverOption(timing) {
    if (!timing?.steeringPreemption)
        return {};
    return {
        steeringPreemptionObserver: (turn, result) => {
            try {
                timing.steeringPreemption?.(turn, result);
            }
            catch {
                /* Observation only. */
            }
        },
    };
}
function responseDiscardedEvent(reporter, sessionId, turnId, messageId) {
    const eventId = reporter.nextEventId('response_discarded');
    return buildStreamRespEvent({
        sessionId,
        turnId,
        eventId,
        runtimeSeq: reporter.nextRuntimeSeq(),
        respData: {
            type: RespDataType.AgentMessage,
            agent_message: {
                msg_id: eventId,
                turn_id: turnId,
                timestamp: Date.now(),
                msg_type: MsgType.SystemEvent,
                msg_content: JSON.stringify({
                    eventType: ASSISTANT_RESPONSE_DISCARDED_EVENT_TYPE,
                    messageIds: [messageId],
                }),
            },
        },
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=user-steering-preemption.js.map