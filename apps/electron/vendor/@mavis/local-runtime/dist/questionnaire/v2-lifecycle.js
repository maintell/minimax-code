import { QUESTIONNAIRE_TTL_MS, } from '@mavis/shared/questionnaire';
import { logger } from '../common/logger.js';
import { LocalQuestionnaireError } from './errors.js';
import { prepareQuestionnaireContextImages } from './context-images.js';
import { haveSameAnswers } from './generic-reply-lifecycle.js';
import { QuestionnaireValidationError, sanitizeReplyAnswers, validateQuestionnaireReply, } from './normalize.js';
import { isQuestionnaireAgentAllowed } from './request-lifecycle.js';
import { deliverV2Answer, markV2Injected } from './v2-answer-delivery.js';
import { isSkipOnlyReply, isV2Questionnaire, publishQuestionnaireState, questionnaireState, } from './v2-state.js';
/**
 * Reply / dismiss / recovery rules for v2 questionnaires (`response_mode`
 * set). Legacy rows never reach this class; `LocalQuestionnaireService`
 * routes by the stored column.
 *
 * Invariants: status only moves pending -> answered | expired; a v2 row is
 * never dismissed or superseded; `injected_at` is written once, when the
 * answer is handed to the model.
 */
export class QuestionnaireV2Lifecycle {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async reply(input) {
        const record = await this.requireRecord(input.requestId, input.agentName, 'reply');
        const session = await this.deps.getSessionById(record.sessionId);
        if (!session) {
            logger.warn({ ...fieldsOf(record), reason: 'session_not_found' }, 'Questionnaire v2 reply rejected; deleting orphan row');
            await this.deps.store.delete(record.requestId);
            throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', record.sessionId);
        }
        // `auto`: the waiting ask_user call answers a Goal question nobody
        // answered in time (Goal + skip). It never replays or retries: an existing
        // answer, a lost race, or a call that stopped waiting all leave it unsent.
        const automatic = input.source === 'auto';
        const prepared = await prepareQuestionnaireContextImages(this.deps, record, validatedReply(record, input.reply, automatic));
        const reply = prepared.reply;
        if (record.status === 'answered') {
            if (automatic)
                throw automaticNotApplied(record, 'already_answered');
            return this.replayAnswered(record, reply);
        }
        if (isSkipOnlyReply(reply)) {
            // No real choice or text: behave like skip/close so the single allowed
            // answer is not consumed by an empty submission.
            if (automatic)
                throw automaticNotApplied(record, 'no_option_selected');
            const now = this.deps.nowMs();
            this.endSyncWait(record, 'skip_only_reply');
            return {
                ...baseResult(record),
                answeredAt: now,
                injected: false,
                state: questionnaireState(record),
            };
        }
        // Checked right before the write with no await in between, so an ending
        // (new message, skip, Stop) that settled the wait first wins.
        if (automatic && this.deps.syncWaits?.isAwaitingReply(record.requestId) !== true) {
            throw automaticNotApplied(record, 'sync_wait_ended');
        }
        const answeredAt = reply.submittedAt;
        let settled;
        try {
            settled = await this.deps.store.settleReply(record.requestId, answeredAt, reply, {
                requirePending: true,
            });
        }
        catch (error) {
            await prepared.discardCreated();
            throw error;
        }
        if (!settled) {
            await prepared.discardCreated();
            const current = await this.deps.store.get(record.requestId);
            if (automatic)
                throw automaticNotApplied(current ?? record, 'reply_lost_race');
            if (current?.status === 'answered')
                return this.replayAnswered(current, reply);
            logger.info({ ...fieldsOf(record), status: current?.status, reason: 'reply_lost_race' }, 'Questionnaire v2 reply rejected');
            throw notPending(current?.status ?? 'deleted');
        }
        const answered = (await this.deps.store.get(record.requestId)) ?? {
            ...record,
            status: 'answered',
            answeredAt,
            replyPayload: reply,
        };
        logger.info({ ...fieldsOf(answered), reason: 'answered' }, 'Questionnaire v2 answered');
        publishQuestionnaireState(this.deps, answered, 'answered');
        return this.deliver(answered, reply);
    }
    async dismiss(input) {
        const record = await this.requireRecord(input.requestId, input.agentName, 'dismiss');
        if (record.status === 'answered') {
            // The answer is valid and is (or will be) delivered; skip/close cannot
            // retract it, unlike the legacy stranded-answer escape hatch.
            logger.info({ ...fieldsOf(record), reason: 'already_answered' }, 'Questionnaire v2 dismiss rejected');
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', 'Questionnaire request is answered');
        }
        // Status stays pending (still answerable later), no dismissed_at, no
        // questionnaire.dismiss event, and no queue kick: v2 rows never gate the
        // queue, so there is nothing to release.
        this.endSyncWait(record, 'dismiss');
        return { ...baseResult(record), dismissedAt: this.deps.nowMs() };
    }
    /** Every unanswered v2 questionnaire in the session, newest first. */
    async listUnanswered(input) {
        const records = await this.deps.store.findUnansweredV2BySession(input.sessionId, this.deps.nowMs() - QUESTIONNAIRE_TTL_MS);
        return records.filter((record) => isQuestionnaireAgentAllowed(record, input.agentName));
    }
    /**
     * Called by the v2 Turn system when the answer reaches the model: a Turn
     * whose input is the answer was admitted (`turn_admitted`), a steered
     * answer was consumed (`steering_consumed`), or a Stopped Turn's teardown
     * committed it into the conversation (`steering_teardown_committed`).
     */
    async markAnswerAdmitted(input) {
        const record = await this.deps.store.get(input.requestId);
        const fields = {
            requestId: input.requestId,
            sessionId: input.sessionId,
            stage: input.stage ?? 'turn_admitted',
        };
        if (!record || record.sessionId !== input.sessionId) {
            logger.info({ ...fields, reason: 'not_found' }, 'Questionnaire answer admission ignored');
            return;
        }
        if (!isV2Questionnaire(record)) {
            // Legacy replies mark injection on their own resume/queue path.
            logger.info({ ...fields, reason: 'legacy_questionnaire' }, 'Questionnaire answer admission ignored');
            return;
        }
        if (record.status !== 'answered' || record.injectedAt !== undefined) {
            logger.info({ ...fieldsOf(record), stage: fields.stage, reason: 'not_waiting_for_injection' }, 'Questionnaire answer admission ignored');
            return;
        }
        await markV2Injected(this.deps, record.requestId, fields.stage);
    }
    /**
     * Startup: answered-but-undelivered v2 rows go through steer again (the wait
     * died). Recovery runs after the runtime is ready, alongside live replies, so
     * it rereads the row and leaves an answer this process already delivered, or
     * a sync wait of this process still owns, alone.
     */
    async recoverAnswer(snapshot) {
        if (this.deps.syncWaits?.has(snapshot.requestId))
            return false;
        const record = await this.deps.store.get(snapshot.requestId);
        if (!record?.replyPayload || record.status !== 'answered' || record.injectedAt !== undefined) {
            return false;
        }
        try {
            const delivery = await deliverV2Answer(this.deps, record, record.replyPayload, {
                allowToolResult: false,
            });
            logger.info({ ...fieldsOf(record), delivery }, 'Questionnaire v2 answer recovered');
            return true;
        }
        catch (error) {
            logger.error({ ...fieldsOf(record), reason: 'recovery_delivery_failed', err: error }, 'Questionnaire v2 answer recovery failed');
            this.deps.emitBusEvent('questionnaire.recovery_inject_failed', {
                requestId: record.requestId,
                sessionId: record.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }
    async replayAnswered(record, reply) {
        if (!record.replyPayload || !haveSameAnswers(record.replyPayload, reply)) {
            logger.info({ ...fieldsOf(record), reason: 'different_answer' }, 'Questionnaire v2 reply rejected');
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', 'Questionnaire request was already answered with different content');
        }
        if (record.injectedAt !== undefined) {
            logger.info({ ...fieldsOf(record), reason: 'idempotent_retry' }, 'Questionnaire v2 reply replayed');
            return this.result(record);
        }
        if (record.replyPayload.source === 'automatic_timeout') {
            // The runtime's deadline answer is delivered by the runtime alone; a user
            // submitting the same options at that moment must not send it twice.
            logger.info({ ...fieldsOf(record), reason: 'automatic_answer_in_delivery' }, 'Questionnaire v2 reply replayed');
            return this.result(record);
        }
        // Same answer retried after a failed delivery: try again (dedupes on the
        // queue identity, so an answer already parked there is not duplicated).
        logger.info({ ...fieldsOf(record), reason: 'retry_undelivered' }, 'Questionnaire v2 reply replayed');
        return this.deliver(record, record.replyPayload);
    }
    async deliver(record, reply) {
        try {
            await deliverV2Answer(this.deps, record, reply, { allowToolResult: true });
        }
        catch (error) {
            // The answer row is durable; startup recovery or a retried reply
            // redelivers it. Surface 503 like the legacy ordinary path.
            logger.error({ ...fieldsOf(record), reason: 'delivery_failed', err: error }, 'Questionnaire v2 answer delivery failed');
            this.deps.emitBusEvent('questionnaire.inject_failed', {
                requestId: record.requestId,
                sessionId: record.sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw new LocalQuestionnaireError(503, 'QUESTIONNAIRE_CONTINUATION_NOT_STARTED', `Questionnaire answer was saved, but it could not be delivered: ${error instanceof Error ? error.message : String(error)}`);
        }
        // Baseline "questionnaire finished" event; Desktop and Remote Control
        // collapse the card on it, so v2 answers keep publishing it.
        this.deps.publishGlobalEvent?.({
            type: 'questionnaire.dismiss',
            payload: {
                requestId: record.requestId,
                sessionId: record.sessionId,
                agentName: record.agentName,
                status: 'answered',
            },
        });
        return this.result((await this.deps.store.get(record.requestId)) ?? record);
    }
    result(record) {
        return {
            ...baseResult(record),
            answeredAt: record.answeredAt ?? this.deps.nowMs(),
            injected: record.injectedAt !== undefined,
            state: questionnaireState(record),
        };
    }
    endSyncWait(record, reason) {
        const ended = this.deps.syncWaits?.settleDismissed(record.requestId) === true;
        logger.info({ ...fieldsOf(record), reason, syncWaitEnded: ended }, ended
            ? 'Questionnaire v2 skip ended the sync wait'
            : 'Questionnaire v2 skip is a no-op: no ask_user call is waiting');
    }
    async requireRecord(requestId, agentName, action) {
        const record = await this.deps.store.get(requestId);
        if (!record) {
            throw new LocalQuestionnaireError(404, 'QUESTIONNAIRE_NOT_FOUND', 'Questionnaire request not found');
        }
        if (!isQuestionnaireAgentAllowed(record, agentName)) {
            throw new LocalQuestionnaireError(403, 'AGENT_SCOPE_MISMATCH', 'Questionnaire request is not visible to this agent');
        }
        const cutoff = this.deps.nowMs() - QUESTIONNAIRE_TTL_MS;
        if (record.status === 'pending' && record.createdAt < cutoff) {
            // Same 24h lifetime as legacy rows: past it the question can no longer
            // be answered, and a sync wait on it (if any) is ended as a skip.
            if (await this.deps.store.expirePendingRequest(record.requestId, cutoff)) {
                const expired = { ...record, status: 'expired' };
                publishQuestionnaireState(this.deps, expired, 'expired');
                this.deps.syncWaits?.settleDismissed(record.requestId);
            }
            logger.info({ ...fieldsOf(record), action, reason: 'expired' }, 'Questionnaire v2 request rejected');
            throw notPending('expired');
        }
        if (record.status !== 'pending' && record.status !== 'answered') {
            logger.info({ ...fieldsOf(record), action, reason: `status_${record.status}` }, 'Questionnaire v2 request rejected');
            throw notPending(record.status);
        }
        return record;
    }
}
function validatedReply(record, input, automatic) {
    try {
        validateQuestionnaireReply(record.request, input);
        return {
            schemaVersion: 2,
            requestId: input.requestId,
            answers: sanitizeReplyAnswers(input),
            submittedAt: input.submittedAt,
            // Serialized as <responseSource>automatic_timeout</responseSource> and
            // <explicitUserConfirmation>false</explicitUserConfirmation>. User
            // answers keep no source, as before.
            ...(automatic ? { source: 'automatic_timeout' } : {}),
        };
    }
    catch (err) {
        throw new LocalQuestionnaireError(400, err instanceof QuestionnaireValidationError
            ? 'QUESTIONNAIRE_INVALID_REPLY'
            : 'VALIDATION_ERROR', err instanceof Error ? err.message : String(err));
    }
}
function baseResult(record) {
    return {
        ok: true,
        requestId: record.requestId,
        sessionId: record.sessionId,
        ...(record.agentName ? { agentName: record.agentName } : {}),
    };
}
function fieldsOf(record) {
    return {
        requestId: record.requestId,
        sessionId: record.sessionId,
        responseMode: record.responseMode,
        status: record.status,
    };
}
function notPending(status) {
    return new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', `Questionnaire request is ${status}`);
}
/** The runtime's automatic answer was not saved; whatever ended the wait stands. */
function automaticNotApplied(record, reason) {
    logger.info({ ...fieldsOf(record), reason }, 'Questionnaire v2 automatic answer not applied');
    return new LocalQuestionnaireError(410, 'QUESTIONNAIRE_AUTO_REPLY_CANCELLED', `Questionnaire automatic answer was not applied: ${reason}`);
}
//# sourceMappingURL=v2-lifecycle.js.map