import { logger } from '../common/logger.js';
/** v2 = the row carries the immutable `response_mode` column. */
export function isV2Questionnaire(record) {
    return record.responseMode !== undefined;
}
export function questionnaireState(record) {
    return {
        requestId: record.requestId,
        status: record.status,
        ...(record.responseMode ? { responseMode: record.responseMode } : {}),
        ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
        ...(record.injectedAt !== undefined ? { injectedAt: record.injectedAt } : {}),
    };
}
/**
 * `questionnaire.state` for a v2 row whose `status` or `injectedAt` changed.
 * Publishing is best-effort after the durable write: a failure is logged and
 * never rolls the change back (clients reconcile through getPending).
 */
export function publishQuestionnaireState(deps, record, reason) {
    if (!isV2Questionnaire(record))
        return;
    try {
        deps.publishGlobalEvent?.({
            type: 'questionnaire.state',
            payload: {
                requestId: record.requestId,
                sessionId: record.sessionId,
                ...(record.agentName ? { agentName: record.agentName } : {}),
                state: {
                    ...questionnaireState(record),
                    ...(record.responseMode === 'sync' && deps.syncWaits
                        ? { syncWaiting: deps.syncWaits.isAwaitingReply(record.requestId) }
                        : {}),
                },
            },
        });
    }
    catch (error) {
        logger.warn({
            requestId: record.requestId,
            sessionId: record.sessionId,
            responseMode: record.responseMode,
            reason,
            err: error,
        }, 'Questionnaire state event publish failed');
    }
}
/**
 * A reply in which every step was skipped with no option, no Others choice
 * and no text carries no answer. For v2 questionnaires it is handled like a
 * dismiss (the question stays answerable) instead of consuming the one
 * allowed answer.
 */
export function isSkipOnlyReply(reply) {
    return (reply.answers.length > 0 &&
        reply.answers.every((answer) => (answer.selectedOptionIds ?? []).length === 0 &&
            answer.selectedOther !== true &&
            !answer.otherText?.trim()));
}
//# sourceMappingURL=v2-state.js.map