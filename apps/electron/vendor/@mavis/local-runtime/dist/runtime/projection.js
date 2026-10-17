import { RuntimeEventType, } from '@mavis/protocol';
export function projectLocalRuntimeEvent(event) {
    if (event.type === RuntimeEventType.STREAM_RESP) {
        const streamResp = event.payload?.stream_resp;
        if (typeof streamResp !== 'string' || streamResp.length === 0)
            return null;
        return {
            kind: 'stream.resp',
            eventId: event.event_id,
            sessionId: event.session_id,
            ...(event.turn_id ? { turnId: event.turn_id } : {}),
            ...(typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {}),
            data: streamResp,
        };
    }
    if (event.type === RuntimeEventType.SESSION_STATUS) {
        return {
            kind: 'session.status',
            eventId: event.event_id,
            sessionId: event.session_id,
            ...(event.turn_id ? { turnId: event.turn_id } : {}),
            ...(event.payload?.status !== undefined ? { status: event.payload.status } : {}),
            ...(event.payload?.stop_reason !== undefined
                ? { stopReason: event.payload.stop_reason }
                : {}),
            event,
        };
    }
    if (event.type === RuntimeEventType.TURN_TERMINAL) {
        return {
            kind: 'turn.terminal',
            eventId: event.event_id,
            sessionId: event.session_id,
            ...(event.turn_id ? { turnId: event.turn_id } : {}),
            ...(typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {}),
            ...(event.payload?.status !== undefined ? { status: event.payload.status } : {}),
            ...(event.payload?.stop_reason !== undefined
                ? { stopReason: event.payload.stop_reason }
                : {}),
            event,
        };
    }
    return {
        kind: 'runtime.event',
        eventId: event.event_id,
        sessionId: event.session_id,
        ...(event.turn_id ? { turnId: event.turn_id } : {}),
        ...(typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {}),
        event,
    };
}
export function projectLocalRuntimeEvents(events) {
    const frames = [];
    for (const event of events) {
        const frame = projectLocalRuntimeEvent(event);
        if (frame)
            frames.push(frame);
    }
    return frames;
}
//# sourceMappingURL=projection.js.map