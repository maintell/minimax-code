/**
 * T3 — stream pump: DesktopService SSE → evt.* frames (M3 opaque pass-through).
 *
 * Input: the raw SSE Response from the final Desktop
 * /minimax-desktop/api/v1/session/:id/{message,resume} POST or its 404-only
 * /mavis/api/session/:id/{message,resume} fallback (handed over by
 * command-router AFTER the ack, §6 rule 1). Frames are parsed with the exact
 * `streamSessionFrames` semantics
 * (desktop-session-stream.ts): `data:` lines joined with '\n' = dataJson,
 * `id:` = cursor (kept pump-internal, never on the wire — the replay anchor
 * is the gateway-assigned envelope event_id), `event:` = eventJson.
 *
 * ★ M3 hard constraint: outbound chunk/msg payloads embed dataJson BYTE FOR
 * BYTE. The envelope is built by string templating —
 *   {"v":1,...,"payload":{"session_id":"…","chunk":<dataJson verbatim>}}
 * — never JSON.parse → re-stringify. dataJson IS parsed read-only (never
 * re-serialized) to route the frame:
 *   RespData type 6 (AgentMessageChunk) → evt.session.message_chunk {chunk}
 *   RespData type 2 (AgentMessage)      → evt.session.message {msg}
 *     (IDL 403/404 — complete messages incl. the role=user echo)
 *   RespData type 10 (Heartbeat)        → skipped (gateway generates its own
 *     heartbeats; IDL §九: heartbeat never rides message frames)
 *   local-runtime {type:"error", error:string, errorCode?:number}
 *                                      → err.<cmd-domain>.<cmd-action>, then
 *                                        stop pumping (no synthetic OK turn_end)
 *   unexpected response-body failure  → retryable DAEMON_UNAVAILABLE err,
 *                                        then stop (no synthetic OK turn_end)
 *   anything else                       → forwarded opaquely as chunk
 * `[DONE]` is the daemon end-of-stream sentinel, not a frame.
 *
 * turn_end preserves the session_status terminal (error/aborted/finished), or
 * an explicit SSE turn_end status, falling back to assistant finish_reason for
 * legacy streams ending in [DONE]. An EOF without a session terminal and an
 * empty response body are stream failures, never synthesized success.
 * Session errorCode is carried as turn_end.error_code; type:"error" frames use
 * the existing err.* path instead.
 *
 * Abort cascade (§6 rule 3): cmd.session.stop → abortSession() cancels the
 * reader and emits the deterministic turn_end{ABORTED}; WS drop → abortAll()
 * cancels every pump WITHOUT emitting (V1 never buffers offline).
 *
 * Oversized frames: sendFrameText enforces max_message_bytes (hello-handed
 * cap); an oversized chunk is dropped + audit-logged + ONE err frame
 * {code:"FRAME_TOO_LARGE"} per stream, and pumping continues.
 *
 * Audit redaction: chunk/msg payload contents never hit the log — only frame
 * counts, types and ids (plan §10).
 */
import { randomUUID } from 'node:crypto';
import { FRAME_TYPES, errTypeForCmd, makeFrame } from './frame-codec.js';
export const TURN_END_STATUS = { OK: 1, ERROR: 2, ABORTED: 3 };
/** RespData envelope type tags (agent-core protocol / archon_protocol). */
const RESP_DATA_TYPE = { AgentMessage: 2, AgentMessageChunk: 6, Heartbeat: 10 };
const DONE_SENTINEL = '[DONE]';
const STREAM_SCOPE_SEPARATOR = '\u0000';
function pumpKey(sessionId, streamScope) {
    return streamScope ? `${streamScope}${STREAM_SCOPE_SEPARATOR}${sessionId}` : sessionId;
}
export class StreamPump {
    deps;
    pumps = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    getActiveCmdId(sessionId, streamScope) {
        return this.pumps.get(pumpKey(sessionId, streamScope))?.cmdId;
    }
    start(input) {
        // One active turn per session within one gateway connection. Independent
        // connections may stream the same session without superseding each other.
        const registryKey = pumpKey(input.sessionId, input.streamScope);
        const stale = this.pumps.get(registryKey);
        if (stale) {
            this.deps.logger.warn(`[rc.pump] superseding stale pump scope=${input.streamScope ?? ''} session=${input.sessionId} cmd=${stale.cmdId}`);
            this.terminate(stale, { emitTurnEnd: false });
        }
        const pump = {
            registryKey,
            streamScope: input.streamScope,
            sessionId: input.sessionId,
            cmdId: input.cmdId,
            cmdType: input.cmdType,
            reader: null,
            aborted: false,
            turnEndSent: false,
            overflowErrSent: false,
            frameCount: 0,
            droppedCount: 0,
            sendFailedCount: 0,
            startedAtMs: (this.deps.nowMs ?? Date.now)(),
            traceId: input.traceId,
        };
        this.deps.logger.info(`[rc.pump] event=stream_start trace_id=${pump.traceId ?? ''} rc_cmd_id=${pump.cmdId} session_id=${pump.sessionId} cmd_type=${pump.cmdType}`);
        this.pumps.set(registryKey, pump);
        void this.run(pump, input.response).catch((err) => {
            this.deps.logger.error(`[rc.pump] pump crashed session=${pump.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            if (pump.aborted || pump.turnEndSent)
                return;
            this.emitUnavailableError(pump);
            this.terminate(pump, { emitTurnEnd: false });
        });
    }
    abortSession(sessionId, cause, streamScope) {
        const pump = this.pumps.get(pumpKey(sessionId, streamScope));
        if (!pump)
            return;
        this.deps.logger.info(`[rc.pump] abort scope=${streamScope ?? ''} session=${sessionId} cause=${cause}`);
        // Deterministic ABORTED turn_end for the phone, then kill the reader.
        this.terminate(pump, { emitTurnEnd: true });
    }
    abortAll(cause, streamScope) {
        const active = [...this.pumps.values()].filter((pump) => streamScope === undefined || pump.streamScope === streamScope);
        if (active.length === 0)
            return;
        this.deps.logger.info(`[rc.pump] abort ALL (${active.length}) scope=${streamScope ?? '*'} cause=${cause}`);
        for (const pump of active) {
            // WS is (going) down — no turn_end can reach the gateway; V1 drops.
            this.terminate(pump, { emitTurnEnd: false });
        }
    }
    terminate(pump, opts) {
        pump.aborted = true;
        if (opts.emitTurnEnd)
            this.emitTurnEnd(pump, TURN_END_STATUS.ABORTED);
        else
            pump.turnEndSent = true; // suppress any later synthesis
        const reader = pump.reader;
        pump.reader = null;
        if (reader) {
            reader.cancel().catch(() => {
                // downstream already closed
            });
        }
        if (this.pumps.get(pump.registryKey) === pump)
            this.pumps.delete(pump.registryKey);
    }
    async run(pump, response) {
        const body = response.body;
        if (!body) {
            this.deps.logger.warn(`[rc.pump] SSE response has no body session=${pump.sessionId}`);
            throw new Error('session stream has no body');
        }
        const reader = body.getReader();
        pump.reader = reader;
        try {
            for await (const rawFrame of readSseFrames(reader)) {
                if (pump.aborted)
                    return;
                const frame = unwrapSessionStreamFrame(rawFrame);
                if (frame.id)
                    pump.lastCursor = frame.id;
                if (frame.event === 'turn_end') {
                    // Forward-compat: an explicit daemon turn_end event ends the turn
                    // (§6 rule 2); its body may carry msg_id/status/error_code.
                    this.finish(pump, readTurnEndFields(frame.data));
                    return;
                }
                if (frame.data === DONE_SENTINEL) {
                    this.finish(pump, {});
                    return;
                }
                if (frame.data.length === 0)
                    continue;
                this.forwardData(pump, frame.data);
                if (pump.aborted)
                    return; // not_connected mid-forward
            }
            // A transport EOF is not evidence that execution completed.
            if (pump.terminalStatus === undefined) {
                throw new Error('session stream ended before its terminal event');
            }
            this.finish(pump, {});
        }
        finally {
            pump.reader = null;
            if (this.pumps.get(pump.registryKey) === pump)
                this.pumps.delete(pump.registryKey);
        }
    }
    /** Peek dataJson read-only for routing/anchors, then forward it verbatim. */
    forwardData(pump, dataJson) {
        let peek;
        try {
            const parsed = JSON.parse(dataJson);
            peek =
                parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? parsed
                    : {};
        }
        catch {
            // A non-JSON data line cannot be embedded into a JSON envelope without
            // corruption — drop it (counted; daemon lines are JSON.stringify output
            // so this only fires on truncation).
            pump.droppedCount += 1;
            this.deps.logger.warn(`[rc.pump] drop non-JSON SSE data line session=${pump.sessionId} (${dataJson.length}B)`);
            return;
        }
        const streamError = readStreamError(peek);
        if (streamError) {
            this.emitStreamError(pump, streamError);
            this.terminate(pump, { emitTurnEnd: false });
            return;
        }
        if (peek.type === RESP_DATA_TYPE.Heartbeat)
            return; // gateway makes its own
        trackAnchors(pump, peek);
        // IDL 403/404 split: complete AgentMessage (incl. role=user echo) rides
        // evt.session.message {msg}; everything else is a message_chunk {chunk}.
        const isCompleteMessage = peek.type === RESP_DATA_TYPE.AgentMessage && peek.agent_message !== undefined;
        const frameType = isCompleteMessage
            ? FRAME_TYPES.EVT_SESSION_MESSAGE
            : FRAME_TYPES.EVT_SESSION_MESSAGE_CHUNK;
        const payloadKey = isCompleteMessage ? 'msg' : 'chunk';
        // ★ Byte-level embed (M3): template splice, dataJson untouched.
        const traceField = pump.traceId ? `"trace_id":${JSON.stringify(pump.traceId)},` : '';
        const text = `{"v":1,"id":${JSON.stringify(`ev-${randomUUID()}`)},"ts":${(this.deps.nowMs ?? Date.now)()},` +
            `"type":"${frameType}","in_reply_to":${JSON.stringify(pump.cmdId)},${traceField}"source":"desktop",` +
            `"payload":{"session_id":${JSON.stringify(pump.sessionId)},"${payloadKey}":${dataJson}}}`;
        const result = this.deps.sender.sendFrameText(text, frameType);
        if (result.ok) {
            pump.frameCount += 1;
            return;
        }
        if (result.reason === 'frame_too_large') {
            pump.droppedCount += 1;
            this.deps.logger.warn(`[rc.pump] chunk over max_message_bytes session=${pump.sessionId} cmd=${pump.cmdId} size=${result.sizeBytes ?? '?'}B — dropped`);
            if (!pump.overflowErrSent) {
                pump.overflowErrSent = true;
                this.deps.sender.sendFrame(makeFrame(errTypeForCmd(pump.cmdType), {
                    code: 'FRAME_TOO_LARGE',
                    message: 'a stream frame exceeded max_message_bytes and was dropped',
                    retryable: false,
                }, { inReplyTo: pump.cmdId, traceId: pump.traceId }));
            }
            return; // keep pumping the rest of the turn
        }
        pump.sendFailedCount += 1;
        // not_connected / send_failed — WS gone; stop this pump quietly
        // (abortAll from the owner usually lands right after).
        this.deps.logger.warn(`[rc.pump] send failed (${result.reason}) session=${pump.sessionId} — stopping pump`);
        this.terminate(pump, { emitTurnEnd: false });
    }
    emitStreamError(pump, error) {
        const sent = this.deps.sender.sendFrame(makeFrame(errTypeForCmd(pump.cmdType), {
            code: 'SESSION_STREAM_ERROR',
            message: error.message,
            retryable: false,
            ...(error.errorCode !== undefined ? { errorCode: error.errorCode } : {}),
        }, { inReplyTo: pump.cmdId, traceId: pump.traceId }));
        if (!sent)
            pump.sendFailedCount += 1;
    }
    emitUnavailableError(pump) {
        const sent = this.deps.sender.sendFrame(makeFrame(errTypeForCmd(pump.cmdType), {
            code: 'DAEMON_UNAVAILABLE',
            message: 'local runtime stream became unavailable',
            retryable: true,
        }, { inReplyTo: pump.cmdId, traceId: pump.traceId }));
        if (!sent)
            pump.sendFailedCount += 1;
    }
    finish(pump, fields) {
        const status = (pump.terminalStatus !== TURN_END_STATUS.OK ? pump.terminalStatus : undefined) ??
            fields.status ??
            pump.terminalStatus ??
            (pump.aborted
                ? TURN_END_STATUS.ABORTED
                : pump.lastFinishReason === 'error'
                    ? TURN_END_STATUS.ERROR
                    : pump.lastFinishReason === 'abort' || pump.lastFinishReason === 'aborted'
                        ? TURN_END_STATUS.ABORTED
                        : TURN_END_STATUS.OK);
        this.emitTurnEnd(pump, status, {
            ...fields,
            errorCode: pump.terminalErrorCode ?? fields.errorCode,
        });
        if (this.pumps.get(pump.registryKey) === pump)
            this.pumps.delete(pump.registryKey);
    }
    emitTurnEnd(pump, status, fields = {}) {
        if (pump.turnEndSent)
            return;
        pump.turnEndSent = true;
        const msgId = fields.msgId ?? pump.lastAssistantMsgId ?? pump.lastMsgId ?? '';
        const durationMs = (this.deps.nowMs ?? Date.now)() - pump.startedAtMs;
        this.deps.logger.info(`[rc.pump] event=stream_event_summary trace_id=${pump.traceId ?? ''} rc_cmd_id=${pump.cmdId} session_id=${pump.sessionId} status=${status} event_count=${pump.frameCount} dropped_count=${pump.droppedCount} send_failed_count=${pump.sendFailedCount} last_event_id=${pump.lastCursor ?? ''} last_msg_id=${msgId} duration_ms=${durationMs}`);
        this.deps.sender.sendFrame(makeFrame(FRAME_TYPES.EVT_SESSION_TURN_END, {
            session_id: pump.sessionId,
            msg_id: msgId,
            status,
            ...(fields.errorCode ? { error_code: fields.errorCode } : {}),
        }, { inReplyTo: pump.cmdId, traceId: pump.traceId }));
    }
}
function readStreamError(peek) {
    if (peek.type !== 'error')
        return undefined;
    return {
        message: typeof peek.error === 'string' ? peek.error : 'session stream failed',
        ...(typeof peek.errorCode === 'number' ? { errorCode: peek.errorCode } : {}),
    };
}
/** Track msg_id / finish_reason anchors from a peeked RespData envelope. */
function trackAnchors(pump, peek) {
    if (peek.type === 'session_status') {
        const terminal = asRecord(peek.session_status);
        const status = terminal?.type;
        if (status === 'error' || status === 'aborted' || status === 'finished') {
            // A later generic finish must not erase an earlier failure/cancellation.
            if (pump.terminalStatus === undefined || pump.terminalStatus === TURN_END_STATUS.OK) {
                pump.terminalStatus =
                    status === 'error'
                        ? TURN_END_STATUS.ERROR
                        : status === 'aborted'
                            ? TURN_END_STATUS.ABORTED
                            : TURN_END_STATUS.OK;
                if (typeof terminal?.errorCode === 'number' || typeof terminal?.errorCode === 'string') {
                    pump.terminalErrorCode = String(terminal.errorCode);
                }
            }
        }
    }
    const message = asRecord(peek.agent_message);
    const chunk = asRecord(peek.agent_message_chunk);
    const carrier = message ?? chunk;
    if (!carrier)
        return;
    const msgId = typeof carrier.msg_id === 'string' ? carrier.msg_id : undefined;
    if (msgId) {
        pump.lastMsgId = msgId;
        // Chunks are assistant deltas by construction; complete messages count
        // only when not the role=user echo.
        if (chunk || carrier.role !== 'user')
            pump.lastAssistantMsgId = msgId;
    }
    const finishReason = typeof carrier.finish_reason === 'string' ? carrier.finish_reason : undefined;
    if (finishReason && (chunk || carrier.role !== 'user'))
        pump.lastFinishReason = finishReason;
}
function readTurnEndFields(data) {
    if (!data || data === DONE_SENTINEL)
        return {};
    try {
        const parsed = asRecord(JSON.parse(data));
        if (!parsed)
            return {};
        return {
            ...(typeof parsed.msg_id === 'string' ? { msgId: parsed.msg_id } : {}),
            ...(typeof parsed.status === 'number' ? { status: parsed.status } : {}),
            ...(typeof parsed.error_code === 'string' ? { errorCode: parsed.error_code } : {}),
        };
    }
    catch {
        return {};
    }
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Minimal SSE reader with `streamSessionFrames` semantics (the module-private
 * parser in packages/local-runtime desktop-session-stream.ts): fields data /
 * event / id, multi `data:` lines joined with '\n' VERBATIM, frame flushed on
 * a blank line (+ tail flush). The Electron Global Events adapter uses the
 * generated DesktopService client instead; this parser remains for the session
 * message stream.
 */
function unwrapSessionStreamFrame(frame) {
    let parsed;
    try {
        parsed = JSON.parse(frame.data);
    }
    catch {
        return frame;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return frame;
    const view = parsed;
    const dataJson = typeof view.data_json === 'string' ? view.data_json : undefined;
    if (dataJson === undefined)
        return frame;
    const cursor = typeof view.cursor === 'string' ? view.cursor : frame.id;
    let event = frame.event;
    if (typeof view.event_json === 'string') {
        try {
            const eventView = JSON.parse(view.event_json);
            if (eventView && typeof eventView === 'object' && !Array.isArray(eventView)) {
                const candidate = eventView.event;
                if (typeof candidate === 'string')
                    event = candidate;
            }
        }
        catch {
            // Malformed optional event metadata does not invalidate the data payload.
        }
    }
    return {
        data: dataJson,
        ...(cursor ? { id: cursor } : {}),
        ...(event ? { event } : {}),
    };
}
export async function* readSseFrames(reader) {
    const decoder = new TextDecoder();
    let buffer = '';
    let dataLines = [];
    let event;
    let id;
    const flush = () => {
        if (dataLines.length === 0 && event === undefined && id === undefined)
            return undefined;
        const frame = {
            data: dataLines.join('\n'),
            ...(id !== undefined ? { id } : {}),
            ...(event !== undefined ? { event } : {}),
        };
        dataLines = [];
        event = undefined;
        id = undefined;
        return frame;
    };
    const consumeLine = (line) => {
        if (line === '')
            return flush();
        if (line.startsWith(':'))
            return undefined;
        const colon = line.indexOf(':');
        const field = colon >= 0 ? line.slice(0, colon) : line;
        const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /u, '') : '';
        if (field === 'data')
            dataLines.push(value);
        else if (field === 'event')
            event = value;
        else if (field === 'id')
            id = value;
        return undefined;
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex = buffer.search(/\r?\n/u);
            while (newlineIndex >= 0) {
                const rawLine = buffer.slice(0, newlineIndex);
                // \r\n is consumed atomically (the match starts at the \r).
                buffer = buffer.slice(newlineIndex + (buffer[newlineIndex] === '\r' ? 2 : 1));
                const frame = consumeLine(rawLine);
                if (frame)
                    yield frame;
                newlineIndex = buffer.search(/\r?\n/u);
            }
        }
        const tail = decoder.decode();
        if (tail)
            buffer += tail;
        if (buffer) {
            const frame = consumeLine(buffer.replace(/\r$/u, ''));
            if (frame)
                yield frame;
        }
        const last = flush();
        if (last)
            yield last;
    }
    finally {
        reader.releaseLock();
    }
}
//# sourceMappingURL=stream-pump.js.map