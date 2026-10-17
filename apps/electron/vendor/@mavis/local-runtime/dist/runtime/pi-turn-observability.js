import { logger } from '../common/logger.js';
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'x-mm-request-id'];
const TRACE_ID_HEADERS = ['x-trace-id', 'trace-id', 'uber-trace-id'];
function safeLog(level, fields, message) {
    try {
        const normalized = fields && typeof fields === 'object' ? fields : {};
        logger[level](normalized, message ?? '[pi-turn-runner]');
    }
    catch {
        // Logging is observability-only and must never alter a turn outcome.
    }
}
function pickIdentifier(headers, keys) {
    for (const key of keys) {
        const value = headers[key];
        if (value?.trim())
            return { key, value };
    }
    return undefined;
}
export const PI_TURN_RUNNER_LOGGER = {
    debug: (fields, message) => safeLog('info', fields, message),
    info: (fields, message) => safeLog('info', fields, message),
    warn: (fields, message) => safeLog('warn', fields, message),
    error: (fields, message) => safeLog('error', fields, message),
};
export function withLlmResponseIdentifierLogging(llm, context) {
    const callerResponseObserver = llm.responseObserver;
    return {
        ...llm,
        responseObserver: async (response, model) => {
            const requestId = pickIdentifier(response.headers, REQUEST_ID_HEADERS);
            const traceId = pickIdentifier(response.headers, TRACE_ID_HEADERS);
            if (requestId || traceId) {
                safeLog('info', {
                    session_id: context.sessionId,
                    turn_id: context.turnId,
                    provider: model.provider,
                    model: model.id,
                    response_status: response.status,
                    ...(requestId
                        ? {
                            downstream_request_id: requestId.value,
                            downstream_request_id_header: requestId.key,
                        }
                        : {}),
                    ...(traceId
                        ? {
                            downstream_trace_id: traceId.value,
                            downstream_trace_id_header: traceId.key,
                        }
                        : {}),
                }, 'llm_response_identifiers');
            }
            await callerResponseObserver?.(response, model);
        },
    };
}
//# sourceMappingURL=pi-turn-observability.js.map