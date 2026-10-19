import { RespDataType, ToolCallStatus } from '@mavis/agent-core/protocol/agent-message';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
const BYOK_ERROR_PREFIX = 'BYOK upstream error';
const BYOK_UPSTREAM_ERROR_SOURCE = 'byok_upstream';
export function deriveLocalTurnRuntimeOutcome(events) {
    const state = {
        status: 'unknown',
        waitingForUser: false,
    };
    events.forEach((event) => updateOutcome(state, event));
    return {
        status: state.status,
        ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
        ...(typeof state.errorCode === 'number' ? { errorCode: state.errorCode } : {}),
        ...(state.errorSource ? { errorSource: state.errorSource } : {}),
        ...(state.errorDetail ? { errorDetail: state.errorDetail } : {}),
        ...(state.errorProviderId ? { errorProviderId: state.errorProviderId } : {}),
        ...(state.messageId ? { messageId: state.messageId } : {}),
        ...(state.waitingForUser ? { waitingForUser: true } : {}),
    };
}
function updateOutcome(state, event) {
    if (event.type === RuntimeEventType.STREAM_RESP) {
        state.messageId = readAssistantMessageId(event) ?? state.messageId;
        state.waitingForUser = hasWaitingForUserToolResult(event) || state.waitingForUser;
        return;
    }
    if (event.type !== RuntimeEventType.SESSION_STATUS)
        return;
    const terminalStatus = event.payload?.status;
    if (terminalStatus === RuntimeEventStatus.COMPLETED) {
        applyCompletedOutcome(state);
        return;
    }
    if (!isAbnormalTerminalStatus(terminalStatus))
        return;
    applyAbnormalOutcome(state, event, terminalStatus);
}
function applyCompletedOutcome(state) {
    state.status = 'completed';
    state.errorMessage = undefined;
    state.errorCode = undefined;
    state.errorSource = undefined;
    state.errorDetail = undefined;
    state.errorProviderId = undefined;
}
function applyAbnormalOutcome(state, event, terminalStatus) {
    state.status = terminalStatus === RuntimeEventStatus.ABORTED ? 'aborted' : 'failed';
    const rawMessage = event.payload?.error?.message ??
        event.payload?.stop_reason?.message ??
        (state.status === 'failed' ? 'Local runtime turn failed' : undefined);
    const normalized = normalizeError(rawMessage, readRuntimeErrorCode(event));
    state.errorMessage = normalized.errorMessage;
    state.errorCode = normalized.errorCode;
    state.errorSource = normalized.errorSource;
    state.errorDetail = normalized.errorDetail;
    state.errorProviderId = normalized.errorProviderId;
}
function isAbnormalTerminalStatus(status) {
    return status === RuntimeEventStatus.ABORTED || status === RuntimeEventStatus.FAILED;
}
function normalizeError(rawMessage, rawErrorCode) {
    const attributed = parseByokErrorStatus(rawMessage, rawErrorCode);
    if (attributed) {
        return {
            errorMessage: attributed.message,
            errorCode: attributed.errorCode,
            errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
            errorDetail: attributed.errorDetail,
            errorProviderId: attributed.errorProviderId,
        };
    }
    return {
        ...(rawMessage ? { errorMessage: rawMessage } : {}),
        ...(typeof rawErrorCode === 'number' ? { errorCode: rawErrorCode } : {}),
    };
}
function parseByokErrorStatus(rawMessage, fallbackErrorCode) {
    if (!rawMessage)
        return undefined;
    const structured = parseStructuredByokMessage(rawMessage, fallbackErrorCode);
    if (structured)
        return structured;
    const legacy = parseLegacyByokMessage(rawMessage);
    if (!legacy)
        return undefined;
    return {
        message: rawMessage,
        errorCode: fallbackErrorCode ?? 50_000,
        errorProviderId: legacy.providerId,
        errorDetail: legacy.detail,
    };
}
function parseStructuredByokMessage(rawMessage, fallbackErrorCode) {
    if (!rawMessage.startsWith(BYOK_ERROR_PREFIX))
        return undefined;
    const start = rawMessage.indexOf('{');
    if (start < 0)
        return undefined;
    try {
        return normalizeStructuredByokPayload(JSON.parse(rawMessage.slice(start)), rawMessage, fallbackErrorCode);
    }
    catch {
        return undefined;
    }
}
function normalizeStructuredByokPayload(payload, rawMessage, fallbackErrorCode) {
    const message = readString(payload, 'message') ?? rawMessage;
    const legacy = parseLegacyByokMessage(message);
    const errorProviderId = readString(payload, 'errorProviderId') ?? legacy?.providerId;
    const errorDetail = readString(payload, 'errorDetail') ?? legacy?.detail;
    if (!errorProviderId || !errorDetail)
        return undefined;
    return {
        message,
        errorCode: typeof payload.errorCode === 'number' ? payload.errorCode : (fallbackErrorCode ?? 50_000),
        errorProviderId,
        errorDetail,
    };
}
function parseLegacyByokMessage(message) {
    const match = /^BYOK provider (?<providerId>.+?) upstream error: (?<detail>[\s\S]*)$/u.exec(message);
    const providerId = match?.groups?.providerId?.trim();
    const detail = match?.groups?.detail?.trim();
    return providerId && detail ? { providerId, detail } : undefined;
}
function readString(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function readRuntimeErrorCode(event) {
    const code = event.payload?.error?.code;
    return typeof code === 'number' ? code : undefined;
}
function readAssistantMessageId(event) {
    const parsed = parseStreamResponse(event);
    if (parsed?.type === RespDataType.AgentMessage) {
        return typeof parsed.agent_message?.msg_id === 'string'
            ? parsed.agent_message.msg_id
            : undefined;
    }
    if (parsed?.type === RespDataType.AgentMessageChunk) {
        return typeof parsed.agent_message_chunk?.msg_id === 'string'
            ? parsed.agent_message_chunk.msg_id
            : undefined;
    }
    return undefined;
}
function hasWaitingForUserToolResult(event) {
    const calls = readToolCalls(parseStreamResponse(event));
    if (!Array.isArray(calls))
        return false;
    return calls.some(isWaitingForUserCall);
}
function readToolCalls(parsed) {
    if (parsed?.type === RespDataType.AgentMessage)
        return parsed.agent_message?.tool_calls;
    if (parsed?.type === RespDataType.AgentMessageChunk) {
        return parsed.agent_message_chunk?.tool_calls;
    }
    return undefined;
}
function isWaitingForUserCall(call) {
    if (!call || typeof call !== 'object')
        return false;
    const record = call;
    if (record.tool_call_status !== ToolCallStatus.Finished)
        return false;
    const result = parseToolCallResult(record.tool_call_result_data);
    if (result?.details?.waiting_for_user === true)
        return true;
    // Decision v3: a suppressed ask_user resolves inline and keeps the turn
    // running; only an explicit false opts out of the legacy fallback below.
    if (result?.details?.waiting_for_user === false)
        return false;
    if (record.tool_name === 'ask_user' && result?.terminate === true)
        return true;
    return record.tool_name === 'ask_user';
}
function parseToolCallResult(value) {
    if (typeof value !== 'string')
        return undefined;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function parseStreamResponse(event) {
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=turn-outcome.js.map