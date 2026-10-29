import { buildRunningSessionStatusEvent } from '../event-bridge/index.js';
import { isLLMRequestStoppedMessage } from './llm-retry.js';
import { immediateSendBatchId } from './outbound-message-normalizer.js';
export async function emitRunning(turn) {
    try {
        await flushEvents(turn.writer, [
            buildRunningSessionStatusEvent({
                sessionId: turn.input.sessionId,
                turnId: turn.input.turnId,
                eventId: turn.nextEventId('coding_running_status'),
            }),
        ]);
    }
    catch (err) {
        turn.metrics.tryRecordTerminalFailure({ errorSource: 'event_writer', errorKind: 'delivery' });
        turn.logger.error({
            sessionId: turn.input.sessionId,
            turnId: turn.input.turnId,
            errorSource: 'event_writer',
            error: err instanceof Error ? err.message : String(err),
        }, '[pi-turn-runner] running event writer failed');
        throw err;
    }
}
export async function emitTerminal(turn, reason) {
    let events;
    try {
        events = (await turn.bridge.emitTerminal(reason)).events;
    }
    catch (err) {
        turn.metrics.tryRecordTerminalFailure({
            errorSource: 'event_bridge',
            errorKind: 'translation',
        });
        turn.logger.error({
            sessionId: turn.input.sessionId,
            turnId: turn.input.turnId,
            secondaryErrorSource: 'event_bridge',
            error: err instanceof Error ? err.message : String(err),
        }, '[pi-turn-runner] terminal event bridge failed');
        throw err;
    }
    try {
        await flushEvents(turn.writer, events);
    }
    catch (err) {
        turn.metrics.tryRecordTerminalFailure({ errorSource: 'event_writer', errorKind: 'delivery' });
        turn.logger.error({
            sessionId: turn.input.sessionId,
            turnId: turn.input.turnId,
            secondaryErrorSource: 'event_writer',
            error: err instanceof Error ? err.message : String(err),
        }, '[pi-turn-runner] terminal event writer failed');
        throw err;
    }
}
export function subscribeEvents(agent, turn, history, nowMs) {
    let pendingMessageID;
    let queue = Promise.resolve();
    let forcedTermination;
    let continuationsClosed = false;
    const existingShouldStopAfterTurn = agent.shouldStopAfterTurn;
    agent.shouldStopAfterTurn = async (context) => forcedTermination !== undefined || (await existingShouldStopAfterTurn?.(context)) === true;
    const applyAfterLlmControl = async (event) => {
        if (event.message.role !== 'assistant' || turn.hooks.afterLLM.length === 0)
            return 'emit';
        if (event.message.stopReason !== 'error')
            turn.recovery.used = false;
        for (const hook of turn.hooks.afterLLM) {
            let decision;
            try {
                decision = await hook({
                    sessionId: turn.input.sessionId,
                    turnId: turn.input.turnId,
                    message: event.message,
                    messages: [...agent.state.messages],
                    signal: turn.input.signal ?? agent.signal,
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                turn.logger.error({
                    session_id: turn.input.sessionId,
                    turn_id: turn.input.turnId,
                    error: message,
                }, '[pi-turn-runner] afterLlmCall hook threw; failing response control closed');
                event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
                forcedTermination = { kind: 'failed', message: `after_llm_call_failed: ${message}` };
                return isEmptyAssistantResponse(event.message) ? 'discard' : 'emit';
            }
            if (!decision || decision.type === 'continue')
                continue;
            if (decision.type === 'replaceText') {
                event.message.content = [
                    ...event.message.content.filter((block) => block.type !== 'text'),
                    { type: 'text', text: decision.text },
                ];
                continue;
            }
            if (decision.type === 'retry') {
                // Pi selects tool calls from this same final message after listeners
                // settle. Strip rejected tool intent synchronously so retry cannot
                // leak side effects before the recovery request is processed.
                event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
                agent.followUp({
                    role: 'user',
                    content: [{ type: 'text', text: decision.prompt }],
                    timestamp: Date.now(),
                });
                return 'discard';
            }
            if (decision.type === 'recover') {
                if (event.message.stopReason !== 'error' ||
                    turn.recovery.used ||
                    turn.input.signal?.aborted === true) {
                    continue;
                }
                turn.recovery.used = true;
                turn.recovery.pending = {
                    reason: decision.reason,
                    errorMessage: event.message.errorMessage ?? '',
                    requestMessages: turn.recovery.lastRequest ?? [],
                };
                return 'discard';
            }
            // A failed response is rejected as a whole. Never let its still-pending
            // tool intent execute.
            event.message.content = event.message.content.filter((block) => block.type !== 'toolCall');
            forcedTermination = { kind: 'failed', message: decision.reason };
            return isEmptyAssistantResponse(event.message) ? 'discard' : 'emit';
        }
        return 'emit';
    };
    /**
     * A request the host refused to send (its request budget closed while a
     * steering, retry or regeneration path still asked for one) ends the Turn
     * normally: Pi reports it as a run failure, which is dropped here and not
     * shown, and `runAgent` does not treat it as a failure.
     */
    const isRefusedRequestFailure = (message) => {
        if (message.role !== 'assistant' ||
            message.stopReason !== 'error' ||
            !isLLMRequestStoppedMessage(message.errorMessage)) {
            return false;
        }
        turn.requestStoppedBeforeSend = true;
        return true;
    };
    const discardAssistantMessage = (event) => {
        // Agent.state and Pi's private loop context are distinct arrays containing
        // the same final message object. Remove the public transcript copy now and
        // let transformContext remove the loop-context copy before the next call.
        turn.rejectedAssistantMessages.add(event.message);
        const messages = agent.state.messages;
        const messageIndex = messages.lastIndexOf(event.message);
        if (messageIndex >= 0) {
            agent.state.messages = [
                ...messages.slice(0, messageIndex),
                ...messages.slice(messageIndex + 1),
            ];
        }
        turn.bridge.discardActiveAssistantMessage();
    };
    const cannotContinueAtIdle = () => forcedTermination !== undefined ||
        turn.input.signal?.aborted === true ||
        agent.state.errorMessage !== undefined;
    const failContinuationPoll = (error) => {
        const message = formatUnknownError(error);
        forcedTermination = {
            kind: 'failed',
            message: `continuation_poll_failed: ${message}`,
        };
        turn.logger.error({
            session_id: turn.input.sessionId,
            turn_id: turn.input.turnId,
            error: message,
        }, '[pi-turn-runner] continuation poll threw; failing the turn closed');
    };
    const pollExternalContinuations = async (event) => {
        if (cannotContinueAtIdle() ||
            event.message.role !== 'assistant' ||
            event.message.stopReason === 'aborted' ||
            event.message.stopReason === 'error') {
            return;
        }
        try {
            const hasToolCalls = event.message.content.some((block) => block.type === 'toolCall');
            let closeRefused = false;
            for (;;) {
                // The poll reports whether more steps already follow. At an exit
                // boundary the host may withhold messages so the close below hands
                // them back to the session instead of extending a finished answer.
                // Once the host closed the Turn's work, every poll is an exit.
                const workClosed = (await turn.input.isWorkClosed?.()) === true;
                const boundary = !workClosed && (hasToolCalls || agent.hasQueuedMessages()) ? 'mid-turn' : 'exit';
                const steering = [
                    ...((await turn.input.getSteeringMessages?.(workClosed ? { boundary, workClosed } : { boundary })) ?? []),
                ];
                enqueueSteering(agent, steering);
                if (steering.length > 0 || hasToolCalls || agent.hasQueuedMessages())
                    return;
                if (!turn.input.tryBeginClose)
                    return;
                if (await turn.input.tryBeginClose({
                    ...lastAssistantMessageContext(event.message),
                    ...(workClosed ? { workClosed } : {}),
                })) {
                    continuationsClosed = true;
                    return;
                }
                if (closeRefused) {
                    throw new Error('continuation close was refused without drainable work');
                }
                closeRefused = true;
            }
        }
        catch (error) {
            failContinuationPoll(error);
        }
    };
    /**
     * A refused request ends the Turn: no further request can carry steering
     * into it. Close once anyway, as a final close the host cannot refuse for
     * pending steering, so user steering this Turn never consumed goes back to
     * the session instead of being dropped when the Turn completes (Goal spec
     * §5.5). Steering that keeps arriving cannot loop: nothing continues.
     */
    const closeAfterRefusedRequest = async () => {
        if (continuationsClosed ||
            !turn.requestStoppedBeforeSend ||
            forcedTermination !== undefined ||
            turn.input.signal?.aborted === true) {
            return;
        }
        continuationsClosed = true;
        await turn.input.tryBeginClose?.({
            ...lastAssistantMessageContext(lastAssistantMessage(agent)),
            workClosed: true,
            final: true,
        });
    };
    const convergeAtIdle = async () => {
        if (!turn.input.tryBeginClose || continuationsClosed)
            return;
        try {
            let closeRefused = false;
            while (!continuationsClosed && !cannotContinueAtIdle()) {
                // A Turn whose work is closed only closes here: its pending user
                // steering is handed back to the session by the close (spec: no
                // input lost, none run inside a Turn that can only wrap up). When
                // other steering refuses that close, the poll below stays a
                // work-closed exit so it still leaves user steering to the session.
                const workClosed = (await turn.input.isWorkClosed?.()) === true;
                if (workClosed &&
                    (await turn.input.tryBeginClose?.({
                        ...lastAssistantMessageContext(lastAssistantMessage(agent)),
                        workClosed: true,
                    }))) {
                    continuationsClosed = true;
                    return;
                }
                const boundary = !workClosed && agent.hasQueuedMessages() ? 'mid-turn' : 'exit';
                const steering = [
                    ...((await turn.input.getSteeringMessages?.(workClosed ? { boundary, workClosed } : { boundary })) ?? []),
                ];
                if (steering.length > 0) {
                    enqueueSteering(agent, steering);
                    closeRefused = false;
                    await agent.continue();
                    continue;
                }
                if (await turn.input.tryBeginClose({
                    ...lastAssistantMessageContext(lastAssistantMessage(agent)),
                    ...(workClosed ? { workClosed } : {}),
                })) {
                    continuationsClosed = true;
                    return;
                }
                if (closeRefused) {
                    throw new Error('continuation close was refused without drainable work');
                }
                closeRefused = true;
            }
            await closeAfterRefusedRequest();
        }
        catch (error) {
            failContinuationPoll(error);
        }
    };
    const writeAgentEvent = async (event, observedAtMs) => {
        let out;
        try {
            out = await turn.bridge.processEvent(event, observedAtMs);
        }
        catch (err) {
            turn.metrics.recordDegradation('event_bridge', 'translation', err);
            throw err;
        }
        if (out.requestAssistantMessageId) {
            // The bridge may ask for the assistant message id before it can emit
            // assistant deltas. Hold later events on the same allocation promise so
            // deltas never race ahead of their message anchor.
            const allocPromise = turn.allocator
                .allocateAssistantMessageId(turn.input.sessionId, turn.input.turnId)
                .then((id) => {
                turn.bridge.setActiveAssistantMessageId(id);
                return id;
            })
                .catch((err) => {
                turn.metrics.recordDegradation('message_identity', 'identity', err);
                const message = err instanceof Error ? err.message : String(err);
                turn.logger.error({ session_id: turn.input.sessionId, turn_id: turn.input.turnId, error: message }, '[pi-turn-runner] assistant message id allocation failed');
                turn.bridge.setActiveAssistantMessageId('');
                throw err;
            });
            pendingMessageID = allocPromise;
            await allocPromise;
        }
        else if (pendingMessageID) {
            await pendingMessageID;
        }
        if (out.events.length > 0) {
            try {
                await flushEvents(turn.writer, out.events);
            }
            catch (err) {
                turn.metrics.recordDegradation('event_writer', 'delivery', err);
                throw err;
            }
        }
    };
    const onAgentEvent = async (event, observedAtMs) => {
        let discardMessage = false;
        try {
            if (event.type === 'message_end') {
                discardMessage =
                    isRefusedRequestFailure(event.message) ||
                        (await applyAfterLlmControl(event)) === 'discard';
                if (discardMessage)
                    discardAssistantMessage(event);
            }
            if (!discardMessage)
                await writeAgentEvent(event, observedAtMs);
        }
        catch (err) {
            turn.logger.error({
                session_id: turn.input.sessionId,
                turn_id: turn.input.turnId,
                event_type: event.type,
                error: err instanceof Error ? err.message : String(err),
            }, '[pi-turn-runner] event handler threw');
        }
        if ((!discardMessage && event.type === 'message_end') || event.type === 'tool_execution_end') {
            await history.flushTail();
        }
        if (event.type === 'turn_end' && turn.hooks.onStepEnd.length > 0) {
            const blockedToolCalls = turn.blockedToolCalls;
            turn.blockedToolCalls = [];
            // Step-end hooks may enqueue follow-up messages into the same Agent.
            // Pi polls those follow-ups after this listener settles, so await the
            // hooks here but keep hook failures isolated to this event branch.
            // (Pi's `turn_end` fires per-step in our vocabulary — see design §11.)
            const signal = turn.input.signal ?? new AbortController().signal;
            for (const hook of turn.hooks.onStepEnd) {
                try {
                    await hook({
                        agent,
                        message: event.message,
                        toolResults: event.toolResults,
                        signal,
                        blockedToolCalls,
                    });
                }
                catch (hookErr) {
                    turn.metrics.recordDegradation('turn_end_hook', 'hook_error', hookErr);
                    turn.logger.error({
                        session_id: turn.input.sessionId,
                        turn_id: turn.input.turnId,
                        error: hookErr instanceof Error ? hookErr.message : String(hookErr),
                    }, '[pi-turn-runner] onStepEnd hook threw; ignoring so agent loop continues');
                }
            }
        }
        if (event.type === 'turn_end')
            await pollExternalContinuations(event);
    };
    const unsubscribe = agent.subscribe((event) => {
        // Capture before queueing or awaiting response hooks so decode timing only
        // spans model events, not caller-side control or delivery work.
        const observedAtMs = nowMs();
        // Serialize caller-side work even when Pi emits events from parallel
        // tool completions. History delivery failures reject the current Pi
        // listener; the resolved queue link still lets Pi's failure events drain.
        const queued = queue.then(() => onAgentEvent(event, observedAtMs));
        queue = queued.catch(() => undefined);
        return queued;
    });
    return {
        unsubscribe,
        drain: () => queue,
        convergeAtIdle,
        forcedTermination: () => forcedTermination,
    };
}
function enqueueSteering(agent, messages) {
    if (messages.some((message) => immediateSendBatchId(message) !== undefined)) {
        agent.steerBatch(messages);
    }
    else {
        messages.forEach((message) => agent.steer(message));
    }
}
function lastAssistantMessage(agent) {
    return [...agent.state.messages]
        .reverse()
        .find((message) => message.role === 'assistant');
}
function lastAssistantMessageContext(message) {
    if (!message)
        return {};
    const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
    return text ? { lastAssistantMessage: text } : {};
}
function formatUnknownError(error) {
    if (error instanceof Error)
        return error.message;
    try {
        return String(error);
    }
    catch {
        return 'unknown continuation error';
    }
}
function isEmptyAssistantResponse(message) {
    const hasVisibleText = message.content.some((block) => block.type === 'text' && block.text.trim().length > 0);
    const hasToolCall = message.content.some((block) => block.type === 'toolCall');
    return !hasVisibleText && !hasToolCall;
}
export async function flushEvents(eventWriter, events) {
    if (events.length === 0)
        return;
    if (typeof eventWriter.appendEvents === 'function') {
        await eventWriter.appendEvents([...events]);
        return;
    }
    for (const event of events) {
        await eventWriter.pushRuntime(event);
    }
}
//# sourceMappingURL=events.js.map