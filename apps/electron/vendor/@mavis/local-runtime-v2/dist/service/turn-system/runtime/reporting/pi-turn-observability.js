import { safeLog } from '../../../../infra/observability/pi-turn-logger.js';
export { PI_TURN_RUNNER_LOGGER } from '../../../../infra/observability/pi-turn-logger.js';
const REQUEST_ID_HEADERS = ['request-id', 'x-request-id', 'x-mm-request-id'];
const TRACE_ID_HEADERS = ['x-trace-id', 'trace-id', 'uber-trace-id'];
function pickIdentifier(headers, keys) {
    for (const key of keys) {
        const value = headers[key];
        if (value?.trim())
            return { key, value };
    }
    return undefined;
}
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