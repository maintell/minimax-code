/**
 * Maps remote session and message wire records (DesktopService views, cloud and
 * Remote Control projections; snake_case or camelCase) to the shapes the local
 * `session` commands already return, so the model reads one format.
 */
/** DesktopService SessionStatusView → local session status. */
const DESKTOP_STATUS = ['idle', 'started', 'error', 'aborted'];
/** Remote Control SessionStatus: 1 idle, 2 thinking, 3 running, 4 awaiting permission. */
const RC_STATUS = { 1: 'idle', 2: 'started', 3: 'started', 4: 'started' };
export function toMavisSession(raw, options = {}) {
    const value = record(raw);
    if (!value)
        return undefined;
    const sessionId = text(wireField(value, 'session_id', 'sessionId', 'id'));
    if (!sessionId)
        return undefined;
    const sessionType = wireField(value, 'session_type', 'sessionType');
    const title = text(value.title);
    return compact({
        sessionId,
        agentName: text(wireField(value, 'agent_name', 'agentName')),
        ...(isWireSessionType(sessionType) ? { sessionType } : {}),
        ...(title !== undefined ? { title } : {}),
        parentSessionId: text(wireField(value, 'parent_session_id', 'parentSessionId')),
        archived: flag(value.archived),
        pinned: flag(value.pinned),
        status: toStatus(value.status, options.statusScale ?? 'desktop'),
        createdAt: numeric(wireField(value, 'created_at', 'createdAt')),
        updatedAt: numeric(wireField(value, 'updated_at', 'updatedAt')),
        lastActiveAt: numeric(wireField(value, 'last_active_at', 'lastActiveAt', 'last_msg_at_ms')),
        workspaceDir: text(wireField(value, 'workspace_dir', 'workspaceDir')),
        isDefaultWorkspace: flag(wireField(value, 'is_default_workspace', 'isDefaultWorkspace')),
        visibility: text(value.visibility),
        purpose: text(value.purpose),
    });
}
/** A session type is carried through only in the two shapes the wire uses for it. */
function isWireSessionType(value) {
    return typeof value === 'number' || typeof value === 'string';
}
/**
 * A remote message in the local display-message shape (`msg_id`, `msg_content`, …).
 *
 * @internal Exported only for focused tests.
 */
export function toMavisMessage(raw) {
    const value = record(raw);
    if (!value)
        return undefined;
    const msgId = text(wireField(value, 'msg_id', 'msgId'));
    if (!msgId)
        return undefined;
    const toolCalls = list(wireField(value, 'tool_calls', 'toolCalls')).flatMap(toToolCall);
    const attachments = list(value.attachments).flatMap(toAttachment);
    return compact({
        msg_id: msgId,
        ...contentFields(value),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...provenanceFields(value),
    });
}
/** The message fields that map one wire spelling straight onto one local field. */
function contentFields(value) {
    return {
        parent_msg_id: text(wireField(value, 'parent_msg_id', 'parentMsgId')),
        turn_id: text(wireField(value, 'turn_id', 'turnId')),
        timestamp: numeric(value.timestamp),
        role: text(value.role),
        msg_type: numeric(wireField(value, 'msg_type', 'msgType')),
        msg_content: text(wireField(value, 'msg_content', 'msgContent')),
        msg_content_source: text(wireField(value, 'msg_content_source', 'msgContentSource')),
        thinking_content: text(wireField(value, 'thinking_content', 'thinkingContent')),
        thinking_duration_ms: numeric(wireField(value, 'thinking_duration_ms', 'thinkingDurationMs')),
        finish_reason: text(wireField(value, 'finish_reason', 'finishReason')),
    };
}
/** Where a message came from, which the local shape carries after its content. */
function provenanceFields(value) {
    return {
        source: text(value.source),
        source_message_id: text(wireField(value, 'source_message_id', 'sourceMessageId')),
        kind: text(value.kind),
        origin: toPeerOrigin(value),
    };
}
/** Maps a message page, dropping records without a message ID. */
export function toMavisMessages(raw) {
    return raw.flatMap((message) => {
        const mapped = toMavisMessage(message);
        return mapped ? [mapped] : [];
    });
}
/** Most recent activity first; rows without a timestamp go last. */
export function sessionActivityMs(session) {
    return (numeric(session.lastActiveAt) ?? numeric(session.updatedAt) ?? numeric(session.createdAt) ?? 0);
}
const REMOTE_SENDER_FIELDS = ['fromDevice', 'fromTitle', 'fromAgent'];
/**
 * Who sent a communication message, as the remote runtime's message view
 * carries it (`origin_json` text, or an `origin` object). Same shape and rules
 * as application/conversation `projectPeerMessageOrigin`, which builds that
 * view on the remote side (this layer cannot import it): `fromSession` must be
 * a non-blank string, `command` is kept when it is a string, `remote` only when
 * it is `true`, and with it `fromDevice` / `fromTitle` / `fromAgent` when they
 * are strings. Anything else is dropped; an unreadable origin yields nothing.
 */
function toPeerOrigin(value) {
    // Cron, background-task and other sources also carry an origin; it is not a sender.
    if (value.source !== 'communication')
        return undefined;
    const origin = parseOrigin(wireField(value, 'origin_json', 'originJson', 'origin'));
    return origin ? peerOriginFields(origin) : undefined;
}
function peerOriginFields(origin) {
    const { fromSession } = origin;
    if (typeof fromSession !== 'string' || !fromSession.trim())
        return undefined;
    const peer = { fromSession };
    if (typeof origin.command === 'string')
        peer.command = origin.command;
    if (origin.remote !== true)
        return peer;
    peer.remote = true;
    for (const field of REMOTE_SENDER_FIELDS) {
        if (typeof origin[field] === 'string')
            peer[field] = origin[field];
    }
    return peer;
}
function parseOrigin(raw) {
    if (typeof raw !== 'string')
        return record(raw);
    try {
        return record(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
function toStatus(value, scale) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value === 'number')
        return statusType(value, scale);
    if (typeof value === 'string')
        return { type: normalizeStatusText(value) };
    const status = record(value);
    if (!status)
        return undefined;
    const base = statusBase(wireField(status, 'status_type', 'statusType', 'type'), scale);
    const message = text(status.message);
    return message ? { ...base, message } : base;
}
/**
 * The status type a status view carries: a number on one of the two scales, or
 * text. Undefined for a number neither scale knows, so an unknown numeric
 * status adds nothing rather than guessing one.
 */
function statusBase(type, scale) {
    if (typeof type === 'number')
        return statusType(type, scale);
    if (typeof type === 'string')
        return { type: normalizeStatusText(type) };
    return {};
}
function statusType(value, scale) {
    const type = scale === 'rc' ? RC_STATUS[value] : DESKTOP_STATUS[value];
    return type ? { type } : undefined;
}
function normalizeStatusText(value) {
    const lower = value.trim().toLowerCase();
    return lower === 'running' || lower === 'thinking' || lower === 'busy' ? 'started' : lower;
}
function toToolCall(raw) {
    const value = record(raw);
    if (!value)
        return [];
    const name = text(wireField(value, 'tool_name', 'toolName'));
    const id = text(wireField(value, 'tool_call_id', 'toolCallId'));
    if (!name || !id)
        return [];
    return [
        compact({
            tool_name: name,
            tool_call_id: id,
            tool_call_status: numeric(wireField(value, 'tool_call_status', 'toolCallStatus')),
            tool_call_args: text(wireField(value, 'tool_call_args', 'toolCallArgs')),
            tool_call_result_data: text(wireField(value, 'tool_call_result_data', 'toolCallResultData')),
        }),
    ];
}
/** Keeps what the model can use: name, path and type; never data URLs or read URLs. */
function toAttachment(raw) {
    const value = record(raw);
    if (!value)
        return [];
    const meta = record(value.meta) ?? {};
    const fileName = text(metaField(value, meta, 'file_name', 'fileName'));
    const filePath = text(metaField(value, meta, 'file_path', 'filePath'));
    const mimeType = text(metaField(value, meta, 'mime_type', 'mimeType'));
    if (!fileName && !filePath)
        return [];
    return [
        compact({
            type: attachmentType(value.type, mimeType),
            file_name: fileName,
            file_path: filePath,
            mime_type: mimeType,
        }),
    ];
}
/** Attachment metadata sits on the record itself or inside its `meta` object. */
function metaField(value, meta, ...names) {
    return wireField(value, ...names) ?? wireField(meta, ...names);
}
/** The declared type when the record carries one, otherwise what its media type says. */
function attachmentType(raw, mimeType) {
    const declared = text(raw);
    if (declared !== undefined)
        return declared;
    return mimeType?.startsWith('image/') ? 'image' : 'file';
}
/** The first spelling that carries a value, as an `a ?? b ?? c` chain would read it. */
function wireField(value, ...names) {
    for (const name of names) {
        const entry = value[name];
        if (entry !== undefined && entry !== null)
            return entry;
    }
    return undefined;
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function list(value) {
    return Array.isArray(value) ? value : [];
}
function text(value) {
    return typeof value === 'string' ? value : undefined;
}
function flag(value) {
    return typeof value === 'boolean' ? value : undefined;
}
/** i64 values may arrive as numbers or numeric strings. */
function numeric(value) {
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/u.test(value.trim()))
        return Number(value);
    return undefined;
}
function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
//# sourceMappingURL=wire-mapping.js.map