import { RuntimeEventType, } from '@mavis/protocol';
function eventIdentity(event) {
    return {
        eventId: event.event_id,
        sessionId: event.session_id,
        ...(event.turn_id ? { turnId: event.turn_id } : {}),
    };
}
function eventSequence(event) {
    return typeof event.runtime_seq === 'number' ? { runtimeSeq: event.runtime_seq } : {};
}
function eventStatus(event) {
    return {
        ...(event.payload?.status !== undefined ? { status: event.payload.status } : {}),
        ...(event.payload?.stop_reason !== undefined ? { stopReason: event.payload.stop_reason } : {}),
    };
}
export function projectLocalRuntimeEvent(event) {
    if (event.type === RuntimeEventType.STREAM_RESP) {
        const streamResp = event.payload?.stream_resp;
        if (typeof streamResp !== 'string' || streamResp.length === 0)
            return null;
        return {
            kind: 'stream.resp',
            ...eventIdentity(event),
            ...eventSequence(event),
            data: streamResp,
        };
    }
    if (event.type === RuntimeEventType.SESSION_STATUS) {
        return {
            kind: 'session.status',
            ...eventIdentity(event),
            ...eventStatus(event),
            event,
        };
    }
    if (event.type === RuntimeEventType.TURN_TERMINAL) {
        return {
            kind: 'turn.terminal',
            ...eventIdentity(event),
            ...eventSequence(event),
            ...eventStatus(event),
            event,
        };
    }
    return {
        kind: 'runtime.event',
        ...eventIdentity(event),
        ...eventSequence(event),
        event,
    };
}
//# sourceMappingURL=projection.js.map