import { projectQuestionnaireRecord } from './request-view.js';
/**
 * Ask fan-out split out of the service class to keep it inside the
 * local-runtime layout budget: publish the global `questionnaire.ask` event
 * and run the best-effort channel delivery hook.
 */
export function emitQuestionnaireAsk(deps, record, deliveryReason = 'created') {
    deps.publishGlobalEvent?.({
        type: 'questionnaire.ask',
        payload: {
            requestId: record.requestId,
            sessionId: record.sessionId,
            agentName: record.agentName,
            request: projectQuestionnaireRecord(deps, record).request,
            deliveryReason,
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