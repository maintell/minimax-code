/**
 * Log the downstream request and trace ids a model response carries, then pass
 * the response on to the observer the model config already had.
 */
export function withLlmResponseIdentifierLogging(llm, context) {
    const responseObserver = llm.responseObserver;
    return {
        ...llm,
        responseObserver: async (response, model) => {
            const requestId = pickResponseIdentifier(response.headers, [
                'request-id',
                'x-request-id',
                'x-mm-request-id',
            ]);
            const traceId = pickResponseIdentifier(response.headers, [
                'x-trace-id',
                'trace-id',
                'uber-trace-id',
            ]);
            if (requestId || traceId) {
                context.logger?.info?.({
                    session_id: context.sessionId,
                    turn_id: context.turnId,
                    provider: model.provider,
                    model: model.id,
                    response_status: response.status,
                    ...(requestId ? { downstream_request_id: requestId } : {}),
                    ...(traceId ? { downstream_trace_id: traceId } : {}),
                }, 'llm_response_identifiers');
            }
            await responseObserver?.(response, model);
        },
    };
}
function pickResponseIdentifier(headers, names) {
    return names.map((name) => headers[name]).find((value) => value?.trim());
}
//# sourceMappingURL=llm-response-identifiers.js.map