import { createHash } from 'node:crypto';
import { MsgType, RespDataType, Role, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/agent-core/protocol';
import { ComputerUseCaptureReporter, isComputerUseTool } from './computer-use-capture/reporter.js';
/** Keeps eval capture fail-open around the native V2 runner. */
export async function runWithLocalEvalReporter(factory, input, execute, logger) {
    const localCapture = input.computerUseCapture?.enabled === true
        ? await beginComputerUseCapture(input, logger)
        : undefined;
    // CU evidence has separate storage consent; never send it to the ordinary network outbox.
    const reporter = localCapture ?? (isComputerUseTurn(input) ? undefined : beginTurn(factory, input, logger));
    let reportedInput = reporter ? withReporter(input, reporter, logger) : input;
    if (localCapture) {
        localCapture.beginTurn({
            turnId: input.turnId,
            userMessage: input.userMessage.text,
            model: input.llm.model,
        });
        reportedInput = {
            ...reportedInput,
            hooks: localCapture.withCheckpointHooks(reportedInput.hooks ?? {}),
        };
    }
    try {
        const result = await execute(reportedInput);
        finishTurn(reporter, result.retracted || result.networkStopped
            ? { ...result.outcome, status: 'aborted' }
            : result.outcome, logger);
        await localCapture?.seal();
        return result;
    }
    catch (error) {
        failTurn(reporter, error, Boolean(input.signal?.aborted), logger);
        await localCapture?.seal();
        throw error;
    }
}
function isComputerUseTurn(input) {
    return (input.computerUseCapture !== undefined ||
        Boolean(input.tools?.some((tool) => isComputerUseTool(tool.def.name))) ||
        Boolean(input.history?.some((message) => (message.role === 'toolResult' && isComputerUseTool(message.toolName)) ||
            (message.role === 'assistant' &&
                message.content.some((part) => part.type === 'toolCall' && isComputerUseTool(part.name))))));
}
async function beginComputerUseCapture(input, logger) {
    const config = input.computerUseCapture;
    if (config?.enabled !== true || config.localStorageConsent !== true)
        return undefined;
    try {
        return await ComputerUseCaptureReporter.create(config, {
            sessionId: input.sessionId,
            turnId: input.turnId,
        }, logger);
    }
    catch (error) {
        if (config.strict)
            throw new Error('computer_use_capture_initialization_failed', { cause: error });
        logFailure(logger, 'computer_use_capture_initialize', error);
        return undefined;
    }
}
function beginTurn(factory, input, logger) {
    let reporter;
    try {
        reporter = factory?.canReport()
            ? factory.getReporter({
                sessionId: input.sessionId,
                workspaceDir: input.workspaceDir,
                ...(input.evalSessionFields ? { sessionFields: input.evalSessionFields } : {}),
            })
            : undefined;
    }
    catch (error) {
        logFailure(logger, 'initialize', error);
    }
    capture(logger, 'begin_turn', () => {
        reporter?.beginTurn({
            turnId: input.turnId,
            userMessage: input.userMessage.text,
            model: input.llm.model,
            apiKey: input.llm.apiKey,
        });
    });
    return reporter;
}
function finishTurn(reporter, outcome, logger) {
    capture(logger, 'finish_turn', () => {
        reporter?.finishTurn({
            status: normalizeOutcomeStatus(outcome.status),
            ...(outcome.errorMessage ? { error: outcome.errorMessage } : {}),
        });
    });
}
function failTurn(reporter, error, aborted, logger) {
    capture(logger, 'finish_turn', () => {
        reporter?.finishTurn({
            status: aborted ? 'aborted' : 'failed',
            error: error instanceof Error ? error.message : String(error),
        });
    });
}
function withReporter(input, reporter, logger) {
    const observation = {
        reporter,
        model: input.llm.model,
        promptMetadata: input.promptMetadata,
        logger,
        reportedToolCallIds: new Set(),
        reportedToolResultIds: new Set(),
    };
    const eventWriter = observeApprovedMessages(input.eventWriter, observation);
    return {
        ...input,
        eventWriter,
        ...(input.toolContext ? { toolContext: { ...input.toolContext, eventWriter } } : {}),
        hooks: withReporterHooks(input.hooks, observation),
    };
}
function withReporterHooks(hooks, observation) {
    const toolStartedAtMs = new Map();
    return {
        ...hooks,
        onLlmCallPreparedHook: [
            ...(hooks?.onLlmCallPreparedHook ?? []),
            (input) => {
                capture(observation.logger, 'snapshot', () => {
                    observation.reporter.reportSnapshot({
                        turnId: input.turnId,
                        phase: input.phase,
                        messages: input.messages,
                        systemPrompt: input.systemPrompt,
                        ...(observation.promptMetadata
                            ? {
                                promptMetadata: {
                                    ...observation.promptMetadata,
                                    system_sha256: createHash('sha256')
                                        .update(input.systemPrompt ?? '')
                                        .digest('hex'),
                                },
                            }
                            : {}),
                        model: input.model,
                        thinkingLevel: input.thinkingLevel,
                        tools: input.tools?.map((tool) => ({
                            name: tool.name,
                            ...(tool.description ? { description: tool.description } : {}),
                            schema: tool.parameters,
                        })),
                    });
                });
                return undefined;
            },
        ],
        afterLlmCallHook: [
            (input) => {
                if (input.message.usage !== undefined) {
                    capture(observation.logger, 'usage', () => {
                        observation.reporter.reportUsage({
                            usage: input.message.usage,
                            model: observation.model,
                        });
                    });
                }
                return undefined;
            },
            ...(hooks?.afterLlmCallHook ?? []),
        ],
        beforeToolCallHook: [
            ...(hooks?.beforeToolCallHook ?? []),
            (toolContext) => {
                toolStartedAtMs.set(toolContext.toolCall.id, Date.now());
                observation.reportedToolCallIds.add(toolContext.toolCall.id);
                capture(observation.logger, 'tool_call', () => {
                    observation.reporter.reportToolCall({
                        toolName: toolContext.toolCall.name,
                        toolCallId: toolContext.toolCall.id,
                        args: toolContext.args,
                    });
                });
                return undefined;
            },
        ],
        afterToolCallHook: [
            ...(hooks?.afterToolCallHook ?? []),
            (toolContext) => {
                const startedAtMs = toolStartedAtMs.get(toolContext.toolCall.id);
                toolStartedAtMs.delete(toolContext.toolCall.id);
                observation.reportedToolResultIds.add(toolContext.toolCall.id);
                capture(observation.logger, 'tool_result', () => {
                    observation.reporter.reportToolResult({
                        toolName: toolContext.toolCall.name,
                        toolCallId: toolContext.toolCall.id,
                        result: toolContext.result,
                        isError: toolContext.isError,
                        ...(startedAtMs === undefined
                            ? {}
                            : { durationMs: Math.max(0, Date.now() - startedAtMs) }),
                    });
                });
                return undefined;
            },
        ],
    };
}
function observeApprovedMessages(writer, observation) {
    let observedEventCount = writer.events.length;
    const observe = (event) => {
        const response = parseRuntimeResponse(event);
        if (response?.type === RespDataType.AgentMessageChunk) {
            for (const toolCall of response.agent_message_chunk?.tool_calls ?? []) {
                observeTerminalToolCall(toolCall, observation);
            }
        }
        const message = parseAssistantMessage(response);
        if (!message)
            return;
        capture(observation.logger, 'assistant_message', () => {
            observation.reporter.reportAssistantMessage({
                content: message.msg_content ?? '',
                model: observation.model,
                ...(message.finish_reason ? { stopReason: message.finish_reason } : {}),
            });
        });
    };
    const observeCommittedEvents = () => {
        while (observedEventCount < writer.events.length) {
            const event = writer.events[observedEventCount];
            observedEventCount += 1;
            if (event)
                capture(observation.logger, 'observe_event', () => observe(event));
        }
    };
    const writeAndObserve = async (write) => {
        try {
            await write();
        }
        finally {
            observeCommittedEvents();
        }
    };
    return {
        events: writer.events,
        pushRuntime: (event) => writeAndObserve(() => writer.pushRuntime(event)),
        appendEvents: (events) => writeAndObserve(() => writer.appendEvents(events)),
    };
}
function observeTerminalToolCall(toolCall, observation) {
    if (!isTerminalToolCall(toolCall))
        return;
    const callAlreadyReported = observation.reportedToolCallIds.has(toolCall.tool_call_id);
    if (!callAlreadyReported) {
        observation.reportedToolCallIds.add(toolCall.tool_call_id);
        capture(observation.logger, 'tool_call', () => {
            observation.reporter.reportToolCall({
                toolName: toolCall.tool_name,
                toolCallId: toolCall.tool_call_id,
                args: parseSerializedValue(toolCall.tool_call_args),
            });
        });
    }
    if (observation.reportedToolResultIds.has(toolCall.tool_call_id))
        return;
    observation.reportedToolResultIds.add(toolCall.tool_call_id);
    const result = parseSerializedValue(toolCall.tool_call_result_data);
    capture(observation.logger, 'tool_result', () => {
        observation.reporter.reportToolResult({
            toolName: toolCall.tool_name,
            toolCallId: toolCall.tool_call_id,
            result: !callAlreadyReported && toolCall.tool_call_status === ToolCallStatus.Failed
                ? withPreExecutionPhase(result)
                : result,
            isError: toolCall.tool_call_status === ToolCallStatus.Failed,
        });
    });
}
function isTerminalToolCall(toolCall) {
    return ((toolCall.tool_call_status === ToolCallStatus.Finished ||
        toolCall.tool_call_status === ToolCallStatus.Failed) &&
        toolCall.tool_name.length > 0 &&
        toolCall.tool_call_id.length > 0);
}
function parseRuntimeResponse(event) {
    if (event.type !== RuntimeEventType.STREAM_RESP)
        return undefined;
    const raw = event.payload?.stream_resp;
    return typeof raw === 'string' && raw.length > 0 ? parseResponse(raw) : undefined;
}
function parseSerializedValue(value) {
    if (value === undefined)
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function withPreExecutionPhase(result) {
    if (!isRecord(result))
        return result;
    return {
        ...result,
        details: {
            ...(isRecord(result.details) ? result.details : {}),
            phase: 'pre_execution',
        },
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function parseAssistantMessage(response) {
    const message = response?.agent_message;
    return response?.type === RespDataType.AgentMessage &&
        message?.role === Role.Assistant &&
        message.kind === undefined &&
        message.msg_type !== MsgType.SystemEvent
        ? message
        : undefined;
}
function parseResponse(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function normalizeOutcomeStatus(status) {
    if (status === 'completed')
        return 'completed';
    if (status === 'aborted')
        return 'aborted';
    return 'failed';
}
function capture(logger, operation, action) {
    try {
        action();
    }
    catch (error) {
        logFailure(logger, operation, error);
    }
}
function logFailure(logger, operation, error) {
    try {
        logger?.warn?.({ operation, error_name: error instanceof Error ? error.name : typeof error }, '[eval-capture] local eval reporting failed open');
    }
    catch {
        // Eval reporting and diagnostics are both best effort.
    }
}
//# sourceMappingURL=eval-reporter.js.map