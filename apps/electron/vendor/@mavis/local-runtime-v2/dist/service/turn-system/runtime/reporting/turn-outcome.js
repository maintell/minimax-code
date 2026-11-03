import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { ProtocolErrorCode, RuntimeEventStatus, RuntimeEventType, } from '@mavis/protocol';
import { parseByokErrorStatus } from '../../../model-system/index.js';
import { hasWaitingForUserToolResult } from '../waiting-for-user.js';
const NON_RETRYABLE_PROTOCOL_CODES = new Set([
    ProtocolErrorCode.LLM_AUTH_ERROR,
    ProtocolErrorCode.LLM_MIGRATION_ERROR,
    ProtocolErrorCode.USAGE_LIMIT_EXCEEDED,
    ProtocolErrorCode.LLM_CREDITS_EXHAUSTED,
    ProtocolErrorCode.LLM_RATE_LIMITED,
    ProtocolErrorCode.SAFETY_UNAVAILABLE,
    ProtocolErrorCode.SAFETY_SENSITIVE,
]);
export function deriveLocalRuntimeTurnOutcome(events) {
    let terminal = { status: 'unknown' };
    let messageId;
    let waitingForUser = false;
    for (const event of events) {
        if (event.type === RuntimeEventType.STREAM_RESP) {
            const nextMessageId = readAssistantMessageId(event);
            if (nextMessageId)
                messageId = nextMessageId;
            if (hasWaitingForUserToolResult(event))
                waitingForUser = true;
            continue;
        }
        if (event.type === RuntimeEventType.SESSION_STATUS) {
            terminal = readTerminalOutcome(event) ?? terminal;
        }
    }
    return {
        ...serializeTerminalOutcome(terminal),
        ...(messageId ? { messageId } : {}),
        ...(waitingForUser ? { waitingForUser } : {}),
    };
}
function readTerminalOutcome(event) {
    const status = event.payload?.status;
    if (status === RuntimeEventStatus.COMPLETED)
        return { status: 'completed' };
    if (status === RuntimeEventStatus.ABORTED) {
        return {
            status: 'aborted',
            ...normalizeRuntimeErrorStatus(event.payload?.stop_reason?.message, readRuntimeErrorCode(event)),
        };
    }
    if (status !== RuntimeEventStatus.FAILED)
        return undefined;
    return {
        status: 'failed',
        ...normalizeRuntimeErrorStatus(event.payload?.error?.message ??
            event.payload?.stop_reason?.message ??
            'Local runtime turn failed', readRuntimeErrorCode(event)),
    };
}
function serializeTerminalOutcome(terminal) {
    const { status, errorMessage, errorCode, errorSource, errorDetail, errorProviderId } = terminal;
    return {
        status,
        ...(errorMessage ? { errorMessage } : {}),
        ...(typeof errorCode === 'number' ? { errorCode } : {}),
        ...(errorSource ? { errorSource } : {}),
        ...(errorDetail ? { errorDetail } : {}),
        ...(errorProviderId ? { errorProviderId } : {}),
        ...(status === 'failed'
            ? { canRetry: !(errorCode !== undefined && NON_RETRYABLE_PROTOCOL_CODES.has(errorCode)) }
            : {}),
    };
}
function normalizeRuntimeErrorStatus(rawMessage, rawErrorCode) {
    const byok = parseByokErrorStatus(rawMessage, rawErrorCode);
    if (byok) {
        return {
            errorMessage: byok.message,
            errorCode: byok.errorCode,
            errorSource: byok.errorSource,
            errorDetail: byok.errorDetail,
            errorProviderId: byok.errorProviderId,
        };
    }
    return {
        ...(rawMessage ? { errorMessage: rawMessage } : {}),
        ...(typeof rawErrorCode === 'number' ? { errorCode: rawErrorCode } : {}),
    };
}
function readRuntimeErrorCode(event) {
    const code = event.payload?.error?.code;
    return typeof code === 'number' ? code : undefined;
}
function readAssistantMessageId(event) {
    const raw = event.payload?.stream_resp;
    if (typeof raw !== 'string' || raw.length === 0)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (parsed.type === RespDataType.AgentMessage) {
            return typeof parsed.agent_message?.msg_id === 'string'
                ? parsed.agent_message.msg_id
                : undefined;
        }
        if (parsed.type === RespDataType.AgentMessageChunk) {
            return typeof parsed.agent_message_chunk?.msg_id === 'string'
                ? parsed.agent_message_chunk.msg_id
                : undefined;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=turn-outcome.js.map