/**
 * Bunny's trace as Developer Tools reads it (spec 17.1): the runtime events
 * Bunny's main conversation emits, kept in a bounded window per session in
 * memory. A restart clears it; Session Clio still receives every event.
 */
/**
 * Events per session kept for reading; older ones are dropped first.
 * @internal Exported only for focused tests.
 */
export const BUNNY_TRACE_EVENTS_PER_SESSION = 200;
/**
 * Payload bytes per session kept for reading; one delta block can be several KB.
 * @internal Exported only for focused tests.
 */
export const BUNNY_TRACE_BYTES_PER_SESSION = 1_000_000;
/**
 * Sessions kept; the one written longest ago is dropped first.
 * @internal Exported only for focused tests.
 */
export const BUNNY_TRACE_SESSIONS = 16;
const BUNNY_TRACE_DEFAULT_LIMIT = 50;
/**
 * UTF-8 bytes the issue feedback's copy of a trace (`bunny/trace.json`) takes at most.
 * @internal Exported only for focused tests.
 */
export const BUNNY_TRACE_FILE_BYTES = 2 * 1024 * 1024;
/** UTF-8 bytes one event takes in that copy at most, so one event never pushes out the rest. */
const BUNNY_TRACE_FILE_EVENT_BYTES = 256 * 1024;
/** Two spaces per level: an event sits two levels deep in the file. */
const FILE_EVENT_INDENT = '    ';
/**
 * One conversation's trace as the issue feedback carries it (`bunny/trace.json`), oldest first
 * and within {@link BUNNY_TRACE_FILE_BYTES}: the newest events that fit are kept, and the older
 * ones left out are counted in `omittedEvents`. An event larger than one event may take keeps
 * its seq, type, Turn and time in its place; its payload becomes `{ omitted: 'too_large',
 * bytes }`, the UTF-8 size of the payload as recorded.
 */
export function bunnyTraceFile(trace, sessionId) {
    const kept = [];
    let omitted = 0;
    // The file around the events, with the largest count of left-out events it can carry.
    let bytes = Buffer.byteLength(traceFile(sessionId, [], BUNNY_TRACE_EVENTS_PER_SESSION), 'utf8');
    for (const record of trace.list(sessionId, BUNNY_TRACE_EVENTS_PER_SESSION)) {
        const event = omitted ? undefined : traceFileEvent(record);
        if (!event || bytes + event.bytes > BUNNY_TRACE_FILE_BYTES) {
            omitted += 1;
            continue;
        }
        kept.unshift(event.event);
        bytes += event.bytes;
    }
    let content = traceFile(sessionId, kept, omitted);
    // Each event's share is measured on its own; the file as written is what the budget holds.
    while (kept.length && Buffer.byteLength(content, 'utf8') > BUNNY_TRACE_FILE_BYTES) {
        kept.shift();
        omitted += 1;
        content = traceFile(sessionId, kept, omitted);
    }
    return content;
}
function traceFile(sessionId, events, omitted) {
    const file = {
        schemaVersion: 1,
        sessionId,
        events,
        ...(omitted ? { omittedEvents: omitted } : {}),
    };
    return `${JSON.stringify(file, null, 2)}\n`;
}
/** One event as the file writes it, and the UTF-8 bytes it adds there. */
function traceFileEvent(record) {
    const head = {
        seq: record.seq,
        eventType: record.eventType,
        ...(record.turnId ? { turnId: record.turnId } : {}),
        occurredAtMs: record.occurredAtMs,
    };
    const event = { ...head, payload: parsedPayload(record.payloadJson) };
    const bytes = fileEventBytes(event);
    if (bytes <= BUNNY_TRACE_FILE_EVENT_BYTES)
        return { event, bytes };
    const stub = {
        ...head,
        payload: { omitted: 'too_large', bytes: Buffer.byteLength(record.payloadJson, 'utf8') },
    };
    return { event: stub, bytes: fileEventBytes(stub) };
}
/**
 * Bytes of an event two levels deep in the file: each of its lines indented, plus the line
 * break before it and the comma after it.
 */
function fileEventBytes(event) {
    const json = JSON.stringify(event, null, 2);
    const lines = json.split('\n').length;
    return Buffer.byteLength(json, 'utf8') + lines * FILE_EVENT_INDENT.length + 2;
}
function parsedPayload(payloadJson) {
    try {
        return JSON.parse(payloadJson);
    }
    catch {
        return payloadJson;
    }
}
/** Bunny events whose names predate the `bunny.` prefix. */
const UNPREFIXED_BUNNY_EVENTS = new Set([
    'bunny_context_config',
    'bunny_round_budget_turn_summary',
]);
/** `bunny.*` events and the two older Bunny names; anything else is not Bunny's trace. */
function isBunnyTraceEvent(eventType) {
    return eventType.startsWith('bunny.') || UNPREFIXED_BUNNY_EVENTS.has(eventType);
}
export class BunnyTraceStore {
    nowMs;
    sessions = new Map();
    seq = 0;
    constructor(nowMs = Date.now) {
        this.nowMs = nowMs;
    }
    record(sessionId, event) {
        if (!sessionId || !isBunnyTraceEvent(event.eventType))
            return;
        const payloadJson = serialize(event.payload);
        const turnId = event.origin?.turnId ?? payloadTurnId(event.payload);
        const window = this.window(sessionId);
        window.records.push({
            seq: ++this.seq,
            eventType: event.eventType,
            sessionId,
            ...(turnId ? { turnId } : {}),
            occurredAtMs: this.nowMs(),
            payloadJson,
        });
        window.bytes += payloadJson.length;
        while (window.records.length > BUNNY_TRACE_EVENTS_PER_SESSION ||
            (window.bytes > BUNNY_TRACE_BYTES_PER_SESSION && window.records.length > 1))
            window.bytes -= window.records.shift()?.payloadJson.length ?? 0;
    }
    /** Newest first; `limit` is clamped to 1..BUNNY_TRACE_EVENTS_PER_SESSION. */
    list(sessionId, limit = BUNNY_TRACE_DEFAULT_LIMIT) {
        const records = this.sessions.get(sessionId)?.records ?? [];
        const count = Math.min(Math.max(1, Math.floor(limit)), BUNNY_TRACE_EVENTS_PER_SESSION);
        return records.slice(-count).reverse();
    }
    window(sessionId) {
        const existing = this.sessions.get(sessionId);
        // Re-inserting keeps the map ordered by last write, oldest first.
        if (existing)
            this.sessions.delete(sessionId);
        const window = existing ?? { records: [], bytes: 0 };
        this.sessions.set(sessionId, window);
        if (this.sessions.size > BUNNY_TRACE_SESSIONS) {
            const oldest = this.sessions.keys().next().value;
            if (oldest !== undefined)
                this.sessions.delete(oldest);
        }
        return window;
    }
}
/**
 * The sink Bunny's trace emitters report through: records Bunny events for
 * Developer Tools, then forwards every event to Session Clio when it exists.
 * Neither side can fail the caller.
 */
export function recordingBunnyTraceSink(store, forward) {
    return {
        reportRuntimeEvent: (sessionId, event) => {
            try {
                store.record(sessionId, event);
            }
            catch {
                // Reading the trace is diagnostics; it never changes the Turn.
            }
            try {
                forward?.reportRuntimeEvent?.(sessionId, event);
            }
            catch {
                // Same for the Session Clio projection.
            }
        },
    };
}
function serialize(payload) {
    try {
        return JSON.stringify(payload ?? {}) ?? '{}';
    }
    catch {
        return '{"unserializable":true}';
    }
}
function payloadTurnId(payload) {
    if (!payload || typeof payload !== 'object')
        return undefined;
    const turnId = Reflect.get(payload, 'turn_id');
    return typeof turnId === 'string' && turnId ? turnId : undefined;
}
//# sourceMappingURL=trace-store.js.map