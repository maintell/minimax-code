import { MsgType, RespDataType, Role, RuntimeEventStatus, RuntimeEventType, ToolCallStatus, } from '@mavis/agent-core/protocol';
export function createFrameProjector(sessionId, turnId, model) {
    const state = { sessionId, turnId, model, started: false, tools: new Map() };
    return {
        project(frame) {
            if (frame.kind !== 'runtime-event' || frame.turnId !== turnId)
                return [];
            try {
                return projectData(state, frame.data);
            }
            catch {
                return [];
            }
        },
    };
}
function projectData(state, data) {
    if (isRecord(data)) {
        if (state.started || !isRunningStatus(data))
            return [];
        state.started = true;
        return [
            {
                type: 'turn.started',
                sessionId: state.sessionId,
                turnId: state.turnId,
                ...(state.model ? { model: state.model } : {}),
            },
        ];
    }
    const response = parseStreamResponse(data);
    if (response?.type === RespDataType.AgentMessageChunk) {
        return projectMessage(state, response.agent_message_chunk, 'text.delta');
    }
    if (response?.type === RespDataType.AgentMessage) {
        return projectMessage(state, response.agent_message, 'message.committed');
    }
    return [];
}
/** Chunks stream text deltas; completed messages commit their text. Both carry tool calls. */
function projectMessage(state, value, textType) {
    const message = assistantMessage(value);
    if (!message)
        return [];
    const text = typeof message.msg_content === 'string' ? message.msg_content : '';
    // Whitespace deltas are part of the reply; a whitespace-only message is not worth committing.
    const hasText = textType === 'text.delta' ? text.length > 0 : text.trim().length > 0;
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return [
        ...(hasText
            ? [{ type: textType, sessionId: state.sessionId, turnId: state.turnId, text }]
            : []),
        ...toolCalls.flatMap((call) => projectToolCall(state, call)),
    ];
}
/** Reports each call once as started and once as finished, whichever frame shows it first. */
function projectToolCall(state, value) {
    const call = readToolCall(value);
    if (!call)
        return [];
    const known = state.tools.get(call.id);
    const name = call.name ?? known?.name;
    if (!name)
        return [];
    const events = [];
    const tool = known ?? { name, finished: false };
    if (!known) {
        state.tools.set(call.id, tool);
        events.push({ type: 'tool.started', sessionId: state.sessionId, turnId: state.turnId, name });
    }
    if (call.done && !tool.finished) {
        tool.finished = true;
        events.push({
            type: 'tool.finished',
            sessionId: state.sessionId,
            turnId: state.turnId,
            name: tool.name,
            ok: call.ok,
        });
    }
    return events;
}
/** Argument-streaming stages (`Preparing` / `Prepared`) are not tool execution and are skipped. */
function readToolCall(value) {
    if (!isRecord(value) || typeof value.tool_call_id !== 'string')
        return undefined;
    const status = value.tool_call_status;
    if (status !== ToolCallStatus.Start &&
        status !== ToolCallStatus.Finished &&
        status !== ToolCallStatus.Failed) {
        return undefined;
    }
    const name = typeof value.tool_name === 'string' && value.tool_name ? value.tool_name : undefined;
    return {
        id: value.tool_call_id,
        ...(name ? { name } : {}),
        done: status !== ToolCallStatus.Start,
        ok: status === ToolCallStatus.Finished,
    };
}
function isRunningStatus(event) {
    return (event.type === RuntimeEventType.SESSION_STATUS &&
        isRecord(event.payload) &&
        event.payload.status === RuntimeEventStatus.RUNNING);
}
/** Stream responses reach the frame as the JSON `RespData` string written by the agent projection. */
function parseStreamResponse(data) {
    if (typeof data !== 'string')
        return undefined;
    try {
        const response = JSON.parse(data);
        return isRecord(response) ? response : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Only the Agent's own reply counts: user echoes, system events, compaction/review cards and
 * terminal error bubbles (reported through `turn.finished`) are skipped.
 */
function assistantMessage(value) {
    if (!isRecord(value) || value.role !== Role.Assistant || value.kind !== undefined) {
        return undefined;
    }
    return value.msg_type === MsgType.SystemEvent || value.finish_reason === 'error'
        ? undefined
        : value;
}
/** Runtime error sources are forwarded only when they are short identifiers, never free text. */
const TURN_ERROR_CODE_PATTERN = /^[A-Za-z][\w.-]{0,63}$/;
/** Undefined when the terminal data carries no known status. */
export function readTurnTerminal(data) {
    if (!isRecord(data))
        return undefined;
    if (data.status === 'completed')
        return { status: 'finished' };
    if (data.status === 'aborted')
        return { status: 'aborted' };
    if (data.status !== 'failed')
        return undefined;
    const code = data.errorSource;
    return {
        status: 'error',
        error: {
            code: typeof code === 'string' && TURN_ERROR_CODE_PATTERN.test(code) ? code : 'TURN_FAILED',
            message: 'The Agent turn failed.',
        },
    };
}
/** The final reply of a turn (or session): the last assistant message with non-blank text. */
export function finalAssistantText(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'assistant')
            continue;
        const body = message.msg_content ?? message.msgContent ?? message.content;
        if (typeof body === 'string' && body.trim())
            return body;
    }
    return undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=projection.js.map