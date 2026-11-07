import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/protocol';
function hasToolCalls(chunk) {
    return Array.isArray(chunk.tool_calls) && chunk.tool_calls.length > 0;
}
/** Holds only assistant text after a successful website deploy; tool frames keep flowing. */
export function projectWebsiteDeployRuntimeEvent(event, state) {
    if (!state.isProjectionActive() || event.type !== RuntimeEventType.STREAM_RESP)
        return event;
    const raw = event.payload.stream_resp;
    if (typeof raw !== 'string')
        return event;
    try {
        const data = JSON.parse(raw);
        if (data.type !== RespDataType.AgentMessageChunk || !data.agent_message_chunk)
            return event;
        const chunk = data.agent_message_chunk;
        if (typeof chunk.msg_content !== 'string' || chunk.msg_content.length === 0)
            return event;
        if (!hasToolCalls(chunk))
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