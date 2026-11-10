import { ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS, } from '../../../infra/legacy-db/questionnaire-action-contracts.js';
/** Read compatibility only: old persisted deadlines never become new UI deadlines. */
export function getQuestionnaireCountdownSeconds(request) {
    const legacyDeadline = request
        .blockingExpiresAt;
    const duration = request.countdownSeconds ??
        (typeof legacyDeadline === 'number' && typeof request.createdAt === 'number'
            ? (legacyDeadline - request.createdAt) / 1000
            : undefined);
    return typeof duration === 'number' && Number.isSafeInteger(duration) && duration > 0
        ? duration
        : ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS;
}
/** Transient domain projection; never write syncWaiting back to request_json. */
export function projectQuestionnaireRecord(deps, record) {
    if (!record.responseMode)
        return record;
    const request = { ...record.request };
    delete request.blockingExpiresAt;
    return {
        ...record,
        request: {
            ...request,
            status: record.status,
            responseMode: record.responseMode,
            ...(deps.isOriginTurnRunning && record.request.requester?.runId
                ? {
                    originTurnRunning: deps.isOriginTurnRunning(record.sessionId, record.request.requester.runId),
                }
                : {}),
            ...projectResponseModeFields(deps, record),
            ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
            ...(record.injectedAt !== undefined ? { injectedAt: record.injectedAt } : {}),
        },
    };
}
/** Async rows carry their countdown; sync rows carry the live wait when the registry is wired. */
function projectResponseModeFields(deps, record) {
    if (record.responseMode === 'async') {
        return { countdownSeconds: getQuestionnaireCountdownSeconds(record.request) };
    }
    return deps.syncWaits ? { syncWaiting: deps.syncWaits.isAwaitingReply(record.requestId) } : {};
}
//# sourceMappingURL=request-view.js.map