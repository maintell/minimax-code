import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { ProtocolErrorCode, RuntimeEventStatus, RuntimeEventType, } from '@mavis/protocol';
import { parseByokErrorStatus } from './byok-error-attribution.js';
import { hasWaitingForUserToolResult } from './waiting-for-user.js';
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
    let status = 'unknown';
    let errorMessage;
    let errorCode;
    let errorSource;
    let errorDetail;
    let errorProviderId;
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
        if (event.type !== RuntimeEventType.SESSION_STATUS)
            continue;
        const terminalStatus = event.payload?.status;
        if (terminalStatus === RuntimeEventStatus.COMPLETED) {
            status = 'completed';
            errorMessage = undefined;
            errorCode = undefined;
            errorSource = undefined;
            errorDetail = undefined;
            errorProviderId = undefined;
        }
        else if (terminalStatus === RuntimeEventStatus.ABORTED) {
            status = 'aborted';
            const nextError = normalizeRuntimeErrorStatus(event.payload?.stop_reason?.message, readRuntimeErrorCode(event));
            errorMessage = nextError.errorMessage;
            errorCode = nextError.errorCode;
            errorSource = nextError.errorSource;
            errorDetail = nextError.errorDetail;
            errorProviderId = nextError.errorProviderId;
        }
        else if (terminalStatus === RuntimeEventStatus.FAILED) {
            status = 'failed';
            const nextError = normalizeRuntimeErrorStatus(event.payload?.error?.message ??
                event.payload?.stop_reason?.message ??
                'Local runtime turn failed', readRuntimeErrorCode(event));
            errorMessage = nextError.errorMessage;
            errorCode = nextError.errorCode;
            errorSource = nextError.errorSource;
            errorDetail = nextError.errorDetail;
            errorProviderId = nextError.errorProviderId;
        }
    }
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
        ...(messageId ? { messageId } : {}),
        ...(waitingForUser ? { waitingForUser } : {}),
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