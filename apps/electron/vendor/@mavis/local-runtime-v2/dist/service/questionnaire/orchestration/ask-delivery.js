import { settleInBackground } from '../../../infra/async/settle.js';
import { projectQuestionnaireRecord } from './request-view.js';
/**
 * Ask fan-out split out of the service class to keep it inside the
 * local-runtime layout budget: publish the global `questionnaire.ask` event
 * and run the best-effort channel delivery hook.
 *
 * Channel delivery never holds up the caller: creating a questionnaire and
 * startup recovery return once the event is published, and a delivery that
 * later rejects is reported as `questionnaire.delivery_failed`.
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
    const delivery = deps.onQuestionnaireAsk?.(record);
    settleInBackground(reportAskDeliveryFailure(deps, record, delivery));
}
async function reportAskDeliveryFailure(deps, record, delivery) {
    try {
        await delivery;
    }
    catch (err) {
        deps.emitBusEvent('questionnaire.delivery_failed', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
//# sourceMappingURL=ask-delivery.js.map