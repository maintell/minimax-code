import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { RespDataType, ToolCallStatus, } from '@mavis/agent-core/protocol/agent-message';
import { asJson } from './json-value.js';
import { DENIED_PREFIX } from './sdk/observe-answer.js';
const MAX_TRACKED_TURNS = 256;
const MCP_PREFIX = 'mcp__';
export class TurnFrameProjector {
    nowMs;
    turns = new Map();
    constructor(nowMs) {
        this.nowMs = nowMs;
    }
    project(frame) {
        const { type } = frame.event;
        if (type === RuntimeEventType.SESSION_STATUS || type === RuntimeEventType.TURN_TERMINAL) {
            return this.status(frame);
        }
        return type === RuntimeEventType.STREAM_RESP ? this.message(frame) : [];
    }
    message(frame) {
        const raw = frame.event.payload.stream_resp;
        if (!raw || (!raw.includes('"tool_calls"') && !raw.includes('"usage"')))
            return [];
        const data = parseRespData(raw);
        const message = data?.type === RespDataType.AgentMessage ? data.agent_message : undefined;
        const body = message ?? chunkOf(data);
        if (!body)
            return [];
        const track = this.track(frame);
        addUsage(track, message?.usage);
        const calls = body.tool_calls ?? [];
        if (calls.length === 0)
            return [];
        const at = body.timestamp ?? this.nowMs();
        return calls.flatMap((call) => this.toolCall(frame, track, call, at) ?? []);
    }
    status(frame) {
        const status = frame.event.payload.status;
        if (status === RuntimeEventStatus.RUNNING) {
            const track = this.track(frame);
            if (track.startedAt !== undefined)
                return [];
            track.startedAt = this.nowMs();
            const prompt = withContent(frame, 'turn.start', { match: {} }, promptOf);
            return [
                observed('turn.start', frame, {
                    startedAt: track.startedAt,
                    ...(prompt === undefined ? {} : { prompt }),
                }),
            ];
        }
        const outcome = terminalStatus(status);
        if (!outcome)
            return [];
        const key = turnKey(frame);
        const track = this.turns.get(key);
        this.turns.delete(key);
        const usage = terminalUsage(frame.event) ?? (track?.reportedUsage ? track : undefined);
        return [
            observed('turn.complete', frame, {
                status: outcome,
                durationMs: track?.startedAt === undefined ? 0 : Math.max(0, this.nowMs() - track.startedAt),
                ...(usage
                    ? { usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } }
                    : {}),
            }),
        ];
    }
    toolCall(frame, track, call, at) {
        const id = call.tool_call_id;
        if (!id || track.settled.has(id))
            return undefined;
        if (call.tool_call_status === ToolCallStatus.Start) {
            if (track.tools.has(id))
                return undefined;
            track.tools.set(id, at);
            return toolStarted(frame, call, at);
        }
        if (call.tool_call_status !== ToolCallStatus.Finished &&
            call.tool_call_status !== ToolCallStatus.Failed) {
            return undefined;
        }
        track.settled.add(id);
        const startedAt = track.tools.get(id);
        track.tools.delete(id);
        return toolSettled(frame, call, startedAt === undefined ? (call.tool_call_duration_ms ?? 0) : Math.max(0, at - startedAt));
    }
    track(frame) {
        const key = turnKey(frame);
        let track = this.turns.get(key);
        if (!track) {
            track = {
                tools: new Map(),
                settled: new Set(),
                inputTokens: 0,
                outputTokens: 0,
                reportedUsage: false,
            };
            this.turns.set(key, track);
            // A turn whose terminal frame never came (crash, no observer left) ages out.
            if (this.turns.size > MAX_TRACKED_TURNS) {
                const oldest = this.turns.keys().next().value;
                if (oldest !== undefined)
                    this.turns.delete(oldest);
            }
        }
        return track;
    }
}
function observed(event, frame, fields) {
    return {
        event,
        payload: {
            sessionId: frame.sessionId,
            turnId: frame.turnId,
            ...(frame.agentId ? { agentId: frame.agentId } : {}),
            ...fields,
        },
        match: {},
    };
}
function toolEvent(event, frame, call, fields) {
    return {
        ...observed(event, frame, {
            toolCallId: call.tool_call_id,
            toolName: call.tool_name,
            ...fields,
        }),
        match: matchOf(call),
    };
}
function toolStarted(frame, call, at) {
    const server = serverOf(call.tool_name);
    const input = withContent(frame, 'tool.call', { match: matchOf(call), toolCallId: call.tool_call_id }, (content) => asJson(content.toolCall(call.tool_call_id)?.input()));
    return toolEvent('tool.call', frame, call, {
        ...(server ? { server } : {}),
        startedAt: at,
        ...(input === undefined ? {} : { input }),
    });
}
function toolSettled(frame, call, durationMs) {
    const output = withContent(frame, 'tool.result', { match: matchOf(call), toolCallId: call.tool_call_id }, (content) => outputOf(content.toolCall(call.tool_call_id)?.output()));
    frame.content?.release?.(call.tool_call_id);
    return toolEvent('tool.result', frame, call, {
        status: toolStatus(call),
        durationMs,
        ...(output === undefined ? {} : { output }),
    });
}
function matchOf(call) {
    const server = serverOf(call.tool_name);
    return { tool: call.tool_name, ...(server ? { server } : {}) };
}
/**
 * Reads content only when the frame has a handle and a hook receives this event; a read that
 * fails costs the content, never the event.
 */
function withContent(frame, event, scope, read) {
    const { content, listens } = frame;
    if (!content || !listens?.(event, scope.match))
        return undefined;
    try {
        return read(content);
    }
    catch {
        frame.onError?.(new Error(`Content read failed: ${event}${scope.toolCallId ? ` toolCallId=${scope.toolCallId}` : ''}`));
        return undefined;
    }
}
/** The prompt text; attachments are metadata only, the key omitted when there are none. */
function promptOf(content) {
    const input = content.userInput();
    const attachments = input.messages.flatMap((message) => (message.attachments ?? []).map((attachment) => ({
        kind: attachment.type ?? 'file',
        ...(attachment.fileName ? { name: attachment.fileName } : {}),
    })));
    return { text: input.text, ...(attachments.length > 0 ? { attachments } : {}) };
}
function outputOf(output) {
    if (!output)
        return undefined;
    const result = output.result === undefined ? undefined : asJson(output.result);
    return {
        ...(output.text === undefined ? {} : { text: output.text }),
        ...(result === undefined ? {} : { result }),
    };
}
function addUsage(track, usage) {
    if (typeof usage?.input_tokens !== 'number' || typeof usage.output_tokens !== 'number')
        return;
    track.inputTokens += usage.input_tokens;
    track.outputTokens += usage.output_tokens;
    track.reportedUsage = true;
}
function turnKey(frame) {
    return `${frame.frameSessionId}\u0000${frame.turnId}`;
}
function terminalStatus(status) {
    if (status === RuntimeEventStatus.COMPLETED)
        return 'completed';
    if (status === RuntimeEventStatus.ABORTED)
        return 'aborted';
    if (status === RuntimeEventStatus.FAILED)
        return 'error';
    return undefined;
}
function terminalUsage(event) {
    const usage = event.payload.usage;
    const inputTokens = Number(usage?.input_tokens);
    const outputTokens = Number(usage?.output_tokens);
    if (!usage || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens))
        return undefined;
    return { inputTokens, outputTokens };
}
/** The server segment of an MCP tool name (`mcp__<server>__<tool>`); none for built-ins. */
function serverOf(toolName) {
    if (!toolName.startsWith(MCP_PREFIX))
        return undefined;
    const rest = toolName.slice(MCP_PREFIX.length);
    const end = rest.indexOf('__');
    return end > 0 ? rest.slice(0, end) : undefined;
}
function toolStatus(call) {
    if (call.tool_call_status === ToolCallStatus.Finished)
        return 'ok';
    return refusalText(call.tool_call_result_data)?.startsWith(DENIED_PREFIX) ? 'denied' : 'error';
}
/** First text of a failed result: `{ error }`, `{ error: { message } }` or `{ content: [text] }`. */
function refusalText(raw) {
    const value = parseObject(raw);
    if (!value)
        return undefined;
    const { error, content } = value;
    if (typeof error === 'string')
        return error;
    return (textOf(error, 'message') ?? textOf(Array.isArray(content) ? content[0] : undefined, 'text'));
}
function textOf(value, field) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const text = Reflect.get(value, field);
    return typeof text === 'string' ? text : undefined;
}
function parseObject(raw) {
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function chunkOf(data) {
    return data?.type === RespDataType.AgentMessageChunk ? data.agent_message_chunk : undefined;
}
function parseRespData(raw) {
    return parseObject(raw);
}
//# sourceMappingURL=observe-projector.js.map