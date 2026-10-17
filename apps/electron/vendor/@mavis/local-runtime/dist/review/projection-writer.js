import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventType } from '@mavis/protocol';
export class ReviewProjectionEventWriter {
    inner;
    state;
    constructor(inner, state) {
        this.inner = inner;
        this.state = state;
    }
    get events() {
        return this.inner.events;
    }
    get frames() {
        return this.inner.frames;
    }
    subscribe(subscriber) {
        return this.inner.subscribe(subscriber);
    }
    snapshot() {
        return this.inner.snapshot();
    }
    async pushRuntime(event) {
        const projected = projectReviewRuntimeEvent(event, this.state);
        if (projected)
            await this.inner.pushRuntime(projected);
    }
    async appendEvents(events) {
        for (const event of events)
            await this.pushRuntime(event);
    }
}
export function projectReviewRuntimeEvent(event, state) {
    if (!state.isProjectionActive() || event.type !== RuntimeEventType.STREAM_RESP) {
        return event;
    }
    const raw = event.payload.stream_resp;
    if (typeof raw !== 'string')
        return event;
    try {
        const data = JSON.parse(raw);
        if (data.type !== RespDataType.AgentMessageChunk || !data.agent_message_chunk) {
            return event;
        }
        const chunk = data.agent_message_chunk;
        if (typeof chunk.msg_content !== 'string' || chunk.msg_content.length === 0) {
            return event;
        }
        const toolCalls = chunk.tool_calls;
        if (!Array.isArray(toolCalls) || toolCalls.length === 0)
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