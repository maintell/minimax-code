/**
 * T1 — WS envelope codec (plan §5, wire = IDL remote_gateway_base.WsEnvelope).
 *
 * ALL frame `type` string constants live in FRAME_TYPES below — single place
 * to rename. §12-1 is settled (plan v1.5, IDL main@057ad1540): the M3 stream
 * frames are evt.session.message_chunk (403) / evt.session.message (404).
 *
 * Decode is total: malformed input returns a typed error, never throws.
 * Encode enforces the max_message_bytes cap. The desktop-side floor/default is
 * 128MiB; ctrl.hello may raise it further, but does not lower the desktop floor.
 */
import { randomUUID } from 'node:crypto';
/** Single source of truth for every frame type string this bridge speaks. */
export const FRAME_TYPES = {
    // ctrl.* — connection control (plan §5.2 / IDL WsMessageType CTRL_*)
    CTRL_HELLO: 'ctrl.hello',
    CTRL_AUTH_COMPLETE: 'ctrl.auth.complete',
    CTRL_PING: 'ctrl.ping',
    CTRL_PONG: 'ctrl.pong',
    CTRL_DISCONNECT_REASON: 'ctrl.disconnect_reason',
    CTRL_REPLAY_OVERFLOW: 'ctrl.replay.overflow',
    // evt.* — reserved for wave 2/3 (stream-pump / permission-upstream).
    // §12-1 settled (plan v1.5 / IDL main): NO evt.session.frame — stream
    // increments are evt.session.message_chunk (WsMessageType 403), complete
    // messages (incl. role=user echo) are evt.session.message (404).
    EVT_SESSION_MESSAGE_CHUNK: 'evt.session.message_chunk',
    EVT_SESSION_MESSAGE: 'evt.session.message',
    EVT_SESSION_TURN_END: 'evt.session.turn_end',
    EVT_SESSION_COMPOSER_MODE_CHANGED: 'evt.session.composer_mode_changed',
    // Permission frames use the verbatim Global Event type with an evt. prefix (type
    // parity: the gateway strips `evt.` on its RC-events outlet so the phone
    // sees the bare `permission.ask` / `permission.resolved`). The gateway's
    // isPermissionEventType bypass matches these exact strings — rename in
    // lockstep or the turn-time authorization relay breaks.
    EVT_PERMISSION_ASK: 'evt.permission.ask',
    EVT_PERMISSION_RESOLVED: 'evt.permission.resolved',
};
/** Namespace prefixes (envelope type = `<namespace>.<domain>.<action>`). */
export const FRAME_NAMESPACES = {
    CTRL: 'ctrl.',
    CMD: 'cmd.',
    ACK: 'ack.',
    ERR: 'err.',
    EVT: 'evt.',
};
export const PROTOCOL_VERSION = 1;
/** Desktop-side frame size floor/default: 128MiB. */
export const DEFAULT_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
export function isCmdFrame(frame) {
    return frame.type.startsWith(FRAME_NAMESPACES.CMD);
}
export function isCtrlFrame(frame) {
    return frame.type.startsWith(FRAME_NAMESPACES.CTRL);
}
/** `cmd.<domain>.<action>` → `err.<domain>.<action>` (plan §4 失败 rule). */
export function errTypeForCmd(cmdType) {
    if (cmdType.startsWith(FRAME_NAMESPACES.CMD)) {
        return `${FRAME_NAMESPACES.ERR}${cmdType.slice(FRAME_NAMESPACES.CMD.length)}`;
    }
    return `${FRAME_NAMESPACES.ERR}unknown`;
}
/** `cmd.<domain>.<action>` → `ack.<domain>.<action>` (wave 2 router will use). */
export function ackTypeForCmd(cmdType) {
    if (cmdType.startsWith(FRAME_NAMESPACES.CMD)) {
        return `${FRAME_NAMESPACES.ACK}${cmdType.slice(FRAME_NAMESPACES.CMD.length)}`;
    }
    return `${FRAME_NAMESPACES.ACK}unknown`;
}
/** Build an outbound envelope with fresh id/ts and source=desktop. */
export function makeFrame(type, payload, opts = {}) {
    const frame = {
        v: PROTOCOL_VERSION,
        id: `f-${randomUUID()}`,
        ts: Date.now(),
        type,
        payload,
        source: 'desktop',
    };
    if (opts.inReplyTo !== undefined)
        frame.in_reply_to = opts.inReplyTo;
    if (opts.traceId !== undefined)
        frame.trace_id = opts.traceId;
    return frame;
}
/**
 * Build a fallback frame for an admitted Global Event without a dedicated mapper:
 * the frame type is the bus event type verbatim with an `evt.` prefix — dots
 * preserved, so the domain/action hierarchy survives (`session.finish` →
 * `evt.session.finish`). Payload is
 * single-layer with top-level keys snake_cased plus ts_ms. Conversion is
 * shallow — nested objects pass through as-is.
 * `evt.`-prefixed → the gateway relays/buffers it unchanged.
 */
export function makeBusEventFrame(eventType, payload, tsMs) {
    return makeFrame(`${FRAME_NAMESPACES.EVT}${eventType}`, {
        ...toSnakeShallow(payload),
        ts_ms: tsMs,
    });
}
/** camelCase → snake_case on top-level keys only (values untouched). */
function toSnakeShallow(payload) {
    const out = {};
    for (const [k, v] of Object.entries(payload)) {
        out[k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()] = v;
    }
    return out;
}
/**
 * ctrl.disconnect_reason payload — IDL CtrlDisconnectReasonPayload is the
 * single key `code` (string form of DisconnectCode); settled per drift #6,
 * no `reason` compatibility key on either direction (no deployed peers).
 */
export function makeDisconnectReasonFrame(reason) {
    return makeFrame(FRAME_TYPES.CTRL_DISCONNECT_REASON, { code: reason });
}
/** Read the DisconnectCode string from an inbound ctrl.disconnect_reason. */
export function readDisconnectReason(frame) {
    const code = frame.payload?.code;
    return typeof code === 'string' ? code : undefined;
}
function validateEnvelope(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { code: 'invalid_envelope', message: 'frame is not a JSON object' };
    }
    const v = value;
    if (v.v !== PROTOCOL_VERSION) {
        return { code: 'invalid_envelope', message: `unsupported protocol version: ${String(v.v)}` };
    }
    if (typeof v.id !== 'string' || v.id.length === 0) {
        return { code: 'invalid_envelope', message: 'missing/invalid id' };
    }
    if (typeof v.type !== 'string' || v.type.length === 0) {
        return { code: 'invalid_envelope', message: 'missing/invalid type' };
    }
    if (typeof v.ts !== 'number' || !Number.isFinite(v.ts)) {
        return { code: 'invalid_envelope', message: 'missing/invalid ts' };
    }
    if (v.payload !== undefined &&
        (typeof v.payload !== 'object' || v.payload === null || Array.isArray(v.payload))) {
        return { code: 'invalid_envelope', message: 'payload must be a JSON object' };
    }
    if (v.in_reply_to !== undefined && typeof v.in_reply_to !== 'string') {
        return { code: 'invalid_envelope', message: 'in_reply_to must be a string' };
    }
    if (v.event_id !== undefined &&
        (typeof v.event_id !== 'number' || !Number.isFinite(v.event_id))) {
        return { code: 'invalid_envelope', message: 'event_id must be a number' };
    }
    if (v.source !== undefined && typeof v.source !== 'string') {
        return { code: 'invalid_envelope', message: 'source must be a string' };
    }
    if (v.trace_id !== undefined && typeof v.trace_id !== 'string') {
        return { code: 'invalid_envelope', message: 'trace_id must be a string' };
    }
    return null;
}
export function decodeFrame(data, opts = {}) {
    const maxBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    if (sizeBytes > maxBytes) {
        return {
            ok: false,
            error: {
                code: 'frame_too_large',
                message: `inbound frame ${sizeBytes}B exceeds max_message_bytes ${maxBytes}B`,
                sizeBytes,
                maxBytes,
            },
        };
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        return {
            ok: false,
            error: { code: 'not_json', message: err instanceof Error ? err.message : String(err) },
        };
    }
    const invalid = validateEnvelope(parsed);
    if (invalid)
        return { ok: false, error: invalid };
    return { ok: true, frame: parsed };
}
export function encodeFrame(frame, opts = {}) {
    const invalid = validateEnvelope(frame);
    if (invalid)
        return { ok: false, error: invalid };
    const maxBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    const text = JSON.stringify(frame);
    const sizeBytes = Buffer.byteLength(text, 'utf8');
    if (sizeBytes > maxBytes) {
        return {
            ok: false,
            error: {
                code: 'frame_too_large',
                message: `outbound frame ${sizeBytes}B exceeds max_message_bytes ${maxBytes}B`,
                sizeBytes,
                maxBytes,
            },
        };
    }
    return { ok: true, text };
}
//# sourceMappingURL=frame-codec.js.map