/**
 * 本地送审和网关模式两条 runner 路径共用的辅助函数：Pi 输入映射、终态事件、侧事件上报、
 * 撤回与中止落库。从 `local-agent-turn-runner.ts` 原样移出，行为不变。
 */
import { agentKindField, wakeField, } from '@mavis/agent-core/pi-turn-runner';
import { buildCompletedTerminalStatusEvent, buildAbortedTerminalStatusEvent, } from '@mavis/agent-core/event-bridge';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RUNTIME_EVENT_SCHEMA, RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import { turnYieldRunOptions } from '../execution/turn-execution-policy.js';
import { deriveLocalTurnRuntimeOutcome } from './turn-outcome.js';
export function missingTurnToolMessage(toolName, childTools) {
    if (!childTools && toolName === 'run_code')
        return 'run_code is disabled for this turn. Use the current native tool catalog.';
    return undefined;
}
export function isTerminalStatus(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS)
        return false;
    const status = event.payload?.status;
    return (status === RuntimeEventStatus.COMPLETED ||
        status === RuntimeEventStatus.ABORTED ||
        status === RuntimeEventStatus.FAILED);
}
export function withTurnEventReporter(context, state) {
    return {
        ...context,
        reporter: {
            nextEventId: state.eventIdGenerator,
            nextRuntimeSeq: state.runtimeSeqGenerator,
            appendEvents: async (events) => {
                // Native side-events must share the attempt writer with Pi so safety buffering
                // cannot deliver a newer runtime sequence before an older buffered event.
                const writer = state.activeWriter;
                if (!writer)
                    throw new Error('Turn event reporter requires an active safety writer.');
                await writer.appendEvents(events);
            },
        },
    };
}
export async function appendCancelledTurn(input, state) {
    // Stopped at waiting tool calls: the continuation writes this output under the same Display id.
    if (input.isYieldStopped?.())
        return;
    if (deriveLocalTurnRuntimeOutcome(input.eventWriter.events).status === 'aborted')
        return;
    const partial = state.approvedPartial;
    if (partial?.msgId && partial.content.trim()) {
        // Pi suppresses the final assistant frame on abort. Persist the released text
        // under its streaming identity before the terminal closes Display delivery.
        await input.eventWriter.appendEvents([
            {
                schema: RUNTIME_EVENT_SCHEMA,
                event_id: state.eventIdGenerator('aborted-partial'),
                runtime_seq: state.runtimeSeqGenerator(),
                session_id: input.sessionId,
                turn_id: input.turnId,
                type: RuntimeEventType.STREAM_RESP,
                payload: {
                    stream_resp: JSON.stringify({
                        type: RespDataType.AgentMessage,
                        agent_message: {
                            msg_id: partial.msgId,
                            role: 'assistant',
                            msg_content: partial.content,
                            finish_reason: 'aborted',
                        },
                    }),
                },
            },
        ]);
    }
    await input.eventWriter.appendEvents([
        buildAbortedTerminalStatusEvent({
            sessionId: input.sessionId,
            turnId: input.turnId,
            statusEventId: state.eventIdGenerator('safety-review-aborted'),
        }),
    ]);
}
export async function recallAttempt(input, safetyWriter, attempt) {
    if (!input.onOutputRecall) {
        throw new Error('Output recall Display retraction is unavailable.');
    }
    if (!input.recallOutputAttemptHistory) {
        throw new Error('Output recall canonical history retraction is unavailable.');
    }
    await input.onOutputRecall({ attempt, messageIds: safetyWriter.getAttemptMessageIds() });
    await input.recallOutputAttemptHistory(attempt);
}
export async function appendSyntheticCompleted(input, statusEventId) {
    await input.eventWriter.appendEvents([
        buildCompletedTerminalStatusEvent({
            sessionId: input.sessionId,
            turnId: input.turnId,
            statusEventId,
        }),
    ]);
}
export function requireToolContext(input) {
    if (!input.toolContext) {
        throw new Error('LocalAgentTurnRunner requires a v2 LocalRuntimeTurnToolContext.');
    }
    return input.toolContext;
}
export function toPiRunTurnInput(input) {
    return {
        ...toPiCoreInput(input),
        ...toPiControlInput(input),
        ...(input.toolCallContent ? { toolCallContent: input.toolCallContent } : {}),
    };
}
function llmPreemptionField(llmPreemption) {
    return llmPreemption ? { llmPreemption } : {};
}
function toPiCoreInput(input) {
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspaceDir: input.workspaceDir,
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        ...(input.beforeUserMessages ? { beforeUserMessages: input.beforeUserMessages } : {}),
        ...(input.startMode ? { startMode: input.startMode } : {}),
        llm: input.llm,
        ...(input.history ? { history: input.history } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.hooks ? { hooks: input.hooks } : {}),
        ...(input.llmRetry ? { llmRetry: input.llmRetry } : {}),
        ...llmPreemptionField(input.llmPreemption),
        ...(input.captureToolTiming !== undefined
            ? { captureToolTiming: input.captureToolTiming }
            : {}),
        ...(input.includeDetailedUsage === true ? { includeDetailedUsage: true } : {}),
        ...(input.caller ? { caller: input.caller } : {}),
        ...agentKindField(input.agentKind),
        ...wakeField(input.wake),
    };
}
function toPiControlInput(input) {
    return {
        ...turnYieldRunOptions(input),
        ...(input.eventIdGenerator ? { eventIdGenerator: input.eventIdGenerator } : {}),
        ...(input.runtimeSeqGenerator ? { runtimeSeqGenerator: input.runtimeSeqGenerator } : {}),
        ...(input.getSteeringMessages ? { getSteeringMessages: input.getSteeringMessages } : {}),
        ...(input.shouldStopAfterSteering
            ? { shouldStopAfterSteering: input.shouldStopAfterSteering }
            : {}),
        ...(input.shouldStopAfterTurn ? { shouldStopAfterTurn: input.shouldStopAfterTurn } : {}),
        ...(input.isWorkClosed ? { isWorkClosed: input.isWorkClosed } : {}),
        ...(input.tryBeginClose ? { tryBeginClose: input.tryBeginClose } : {}),
        ...(input.unexpectedToolCallFallback
            ? { unexpectedToolCallFallback: input.unexpectedToolCallFallback }
            : {}),
    };
}
export function combineAbortSignals(...signals) {
    const controller = new AbortController();
    signals.forEach((signal) => {
        if (!signal || controller.signal.aborted)
            return;
        if (signal.aborted) {
            controller.abort(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => {
            if (!controller.signal.aborted)
                controller.abort(signal.reason);
        }, { once: true });
    });
    return controller.signal;
}
//# sourceMappingURL=turn-runner-support.js.map