/**
 * Ask fan-out split out of the service class to keep it inside the
 * local-runtime layout budget: publish the global `questionnaire.ask` event
 * and run the best-effort channel delivery hook.
 */
export function emitQuestionnaireAsk(deps, record) {
    deps.publishGlobalEvent?.({
        type: 'questionnaire.ask',
        payload: {
            requestId: record.requestId,
            sessionId: record.sessionId,
            agentName: record.agentName,
            request: record.request,
        },
    });
    void Promise.resolve(deps.onQuestionnaireAsk?.(record)).catch((err) => {
        deps.emitBusEvent('questionnaire.delivery_failed', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
    });
}
//# sourceMappingURL=ask-delivery.js.map