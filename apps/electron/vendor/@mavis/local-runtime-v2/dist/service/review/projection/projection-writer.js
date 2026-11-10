import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/protocol';
export function projectReviewRuntimeEvent(event, state) {
    if (!state.isProjectionActive() || event.type !== RuntimeEventType.STREAM_RESP)
        return event;
    const raw = event.payload.stream_resp;
    if (typeof raw !== 'string')
        return event;
    return projectReviewStreamResponse(event, raw);
}
function projectReviewStreamResponse(event, raw) {
    try {
        const data = JSON.parse(raw);
        const chunk = data.agent_message_chunk;
        if (data.type !== RespDataType.AgentMessageChunk || !chunk)
            return event;
        if (typeof chunk.msg_content !== 'string' || chunk.msg_content.length === 0)
            return event;
        if (!Array.isArray(chunk.tool_calls) || chunk.tool_calls.length === 0)
            return undefined;
        return {
            ...event,
            payload: {
                ...event.payload,
                stream_resp: JSON.stringify({
                    ...data,
                    agent_message_chunk: { ...chunk, msg_content: '' },
                }),
            },
        };
    }
    catch {
        return event;
    }
}
//# sourceMappingURL=projection-writer.js.map