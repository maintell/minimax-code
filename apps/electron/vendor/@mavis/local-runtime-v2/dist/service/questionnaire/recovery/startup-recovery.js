import { QUESTIONNAIRE_TTL_MS } from '@mavis/shared/questionnaire';
import { emitQuestionnaireAsk } from '../orchestration/ask-delivery.js';
import { logger } from '../../../infra/logging/logger.js';
import { isV2Questionnaire, publishQuestionnaireState } from '../response-mode/v2-state.js';
export async function recoverQuestionnairesOnStartup(input) {
    const { deps } = input;
    const aborted = () => input.signal?.aborted === true;
    const expired = await expireStaleQuestionnairesOnStartup(input);
    let reinjected = 0;
    let reemitted = 0;
    if (aborted())
        return { expired, reinjected, reemitted };
    for (const record of await deps.store.findAnsweredPendingInject()) {
        if (aborted())
            return { expired, reinjected, reemitted };
        if (await recoverAnsweredQuestionnaire(input, record))
            reinjected += 1;
    }
    if (aborted())
        return { expired, reinjected, reemitted };
    const pendingForRecovery = await deps.store.findAllPendingForRecovery();
    for (const record of [...pendingForRecovery].reverse()) {
        if (aborted())
            return { expired, reinjected, reemitted };
        emitQuestionnaireAsk(deps, record, 'recovery');
        reemitted += 1;
    }
    await wakeAsyncCountdownQueues(input, pendingForRecovery, aborted);
    return { expired, reinjected, reemitted };
}
/**
 * An async countdown holds earlier queued messages with an in-memory timer
 * that died with the last process, and nothing else dispatches an idle
 * Session's queue after a restart. Wake each Session with an unanswered async
 * questionnaire once: queue selection then re-arms the timer at the original
 * deadline, or lets the messages run when the countdown ended while the
 * runtime was down.
 */
async function wakeAsyncCountdownQueues(input, pending, aborted) {
    if (!input.wakeAsyncCountdownQueue)
        return;
    const sessionIds = new Set(pending.filter((record) => record.responseMode === 'async').map((record) => record.sessionId));
    for (const sessionId of sessionIds) {
        if (aborted())
            return;
        await input.wakeAsyncCountdownQueue(sessionId);
    }
}
async function recoverAnsweredQuestionnaire(input, record) {
    if (!record.replyPayload || record.request.purpose === 'goal')
        return false;
    if (record.responseMode && input.recoverV2Answer)
        return input.recoverV2Answer(record);
    return reinjectAnsweredReply(input, record, record.replyPayload);
}
async function reinjectAnsweredReply(input, record, replyPayload) {
    const { deps } = input;
    try {
        const result = await input.injectReply(record, replyPayload);
        if (!result.completed) {
            deps.emitBusEvent('questionnaire.recovery_inject_failed', {
                requestId: record.requestId,
                sessionId: record.sessionId,
                ...(result.status !== undefined ? { status: result.status } : {}),
                ...(result.error ? { error: result.error } : {}),
            });
            return false;
        }
        await deps.store.markInjected(record.requestId, deps.nowMs());
        if (result.admissionMode === 'duplicate') {
            await input.wakeQueueAfterDuplicateResume(record);
        }
        return true;
    }
    catch (err) {
        deps.emitBusEvent('questionnaire.recovery_inject_failed', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}
/**
 * Bulk-expires ordinary pending rows past the TTL. It only rewrites local
 * Questionnaire state, so the v2 runtime runs it before readiness while reply
 * injection and ask replay stay in the background startup recovery.
 */
export async function expireStaleQuestionnairesOnStartup(input) {
    const { deps } = input;
    const cutoff = deps.nowMs() - (input.ttlMs ?? QUESTIONNAIRE_TTL_MS);
    // v2 clients merge `questionnaire.state` snapshots, so each v2 row this
    // bulk expiry flips must be announced; legacy rows keep the silent baseline.
    const expiringV2 = (await deps.store.findAllPendingForRecovery()).filter((record) => isV2Questionnaire(record) && record.createdAt < cutoff);
    const expired = await deps.store.expirePendingOlderThan(cutoff);
    await publishExpiredV2(deps, expiringV2);
    return expired;
}
async function publishExpiredV2(deps, candidates) {
    for (const candidate of candidates) {
        const current = await deps.store.get(candidate.requestId);
        if (current?.status !== 'expired') {
            // Answered (or deleted) between the read and the expiry: nothing expired.
            logger.info({
                requestId: candidate.requestId,
                sessionId: candidate.sessionId,
                responseMode: candidate.responseMode,
                status: current?.status ?? 'deleted',
                reason: 'not_expired_by_startup',
            }, 'Questionnaire v2 startup expiry skipped');
            continue;
        }
        logger.info({
            requestId: current.requestId,
            sessionId: current.sessionId,
            responseMode: current.responseMode,
            reason: 'expired_at_startup',
        }, 'Questionnaire v2 expired at startup');
        publishQuestionnaireState(deps, current, 'expired_at_startup');
    }
}
//# sourceMappingURL=startup-recovery.js.map