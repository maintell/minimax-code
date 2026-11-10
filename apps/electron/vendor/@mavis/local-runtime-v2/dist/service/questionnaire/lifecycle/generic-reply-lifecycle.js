import { LocalQuestionnaireError } from '../../../infra/legacy-db/questionnaire-errors.js';
import { QuestionnaireValidationError, sanitizeReplyAnswers, validateQuestionnaireReply, } from '../../../infra/legacy-db/questionnaire-normalize.js';
import { isOwnedQuestionnaireRequest, QuestionnaireOwnedActionLifecycle, } from './owned-action-lifecycle.js';
import { isQuestionnaireAgentAllowed } from './request-lifecycle.js';
export class QuestionnaireGenericReplyLifecycle {
    deps;
    ownedActionLifecycle;
    wakeQueueAfterDuplicateResume;
    constructor(deps, ownedActionLifecycle, wakeQueueAfterDuplicateResume) {
        this.deps = deps;
        this.ownedActionLifecycle = ownedActionLifecycle;
        this.wakeQueueAfterDuplicateResume = wakeQueueAfterDuplicateResume;
    }
    async reply(input) {
        const record = await this.requireReplyRecord(input.requestId, input.agentName);
        await this.requireSession(record);
        const reply = this.normalizeReply(record, input.reply);
        const ownedAction = isOwnedQuestionnaireRequest(record.request);
        const settled = await this.settleReply(record, reply, ownedAction);
        const answeredRecord = {
            ...record,
            status: 'answered',
            answeredAt: settled.answeredAt,
            replyPayload: settled.reply,
        };
        const completed = await this.processReply(answeredRecord, settled.reply, ownedAction);
        await this.finishReply(answeredRecord, settled.reply, ownedAction, completed);
        this.deps.publishGlobalEvent?.({
            type: 'questionnaire.dismiss',
            payload: {
                requestId: record.requestId,
                sessionId: record.sessionId,
                agentName: record.agentName,
                status: 'answered',
            },
        });
        return {
            ok: true,
            requestId: record.requestId,
            sessionId: record.sessionId,
            ...(record.agentName ? { agentName: record.agentName } : {}),
            answeredAt: settled.answeredAt,
            injected: completed?.completed === true,
        };
    }
    async requireSession(record) {
        if (await this.deps.getSessionById(record.sessionId))
            return;
        await this.deps.store.delete(record.requestId);
        throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', record.sessionId);
    }
    normalizeReply(record, input) {
        try {
            validateQuestionnaireReply(record.request, input);
            return {
                schemaVersion: 2,
                requestId: input.requestId,
                answers: sanitizeReplyAnswers(input),
                submittedAt: input.submittedAt,
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = err instanceof QuestionnaireValidationError
                ? 'QUESTIONNAIRE_INVALID_REPLY'
                : 'VALIDATION_ERROR';
            throw new LocalQuestionnaireError(400, code, message);
        }
    }
    async settleReply(record, reply, ownedAction) {
        const persistedReply = !ownedAction && record.status === 'answered' ? record.replyPayload : undefined;
        if (persistedReply && !haveSameAnswers(persistedReply, reply)) {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', `Questionnaire request is ${record.status}`);
        }
        const continuationReply = persistedReply ?? reply;
        const answeredAt = record.answeredAt ?? continuationReply.submittedAt;
        if (persistedReply)
            return { reply: continuationReply, answeredAt };
        await this.persistReply(record, answeredAt, continuationReply, ownedAction);
        return { reply: continuationReply, answeredAt };
    }
    async persistReply(record, answeredAt, reply, ownedAction) {
        const settled = this.deps.store.settleReply
            ? await this.deps.store.settleReply(record.requestId, answeredAt, reply, {
                requirePending: ownedAction,
            })
            : await this.deps.store.markAnswered(record.requestId, answeredAt, reply);
        if (!settled) {
            throw new LocalQuestionnaireError(ownedAction ? 410 : 409, ownedAction ? 'QUESTIONNAIRE_NOT_PENDING' : 'QUESTIONNAIRE_ALREADY_ANSWERED', 'Questionnaire request changed while the reply was being submitted');
        }
    }
    async processReply(answeredRecord, reply, ownedAction) {
        try {
            const completed = await this.ownedActionLifecycle.processAnswered(answeredRecord, reply, true);
            if (completed.completed)
                return completed;
            await this.handleIncompleteReply(answeredRecord, ownedAction, completed);
            return completed;
        }
        catch (err) {
            this.deps.emitBusEvent('questionnaire.inject_failed', {
                requestId: answeredRecord.requestId,
                sessionId: answeredRecord.sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
            const recoverOwnedAction = this.ownedActionRecovery(ownedAction);
            if (recoverOwnedAction) {
                recoverOwnedAction(answeredRecord.requestId);
                return undefined;
            }
            throw new LocalQuestionnaireError(503, 'QUESTIONNAIRE_CONTINUATION_NOT_STARTED', `Questionnaire answer was saved, but the continuation could not start: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async handleIncompleteReply(record, ownedAction, completed) {
        this.deps.emitBusEvent('questionnaire.inject_failed', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            ...(completed.status !== undefined ? { status: completed.status } : {}),
            ...(completed.error ? { error: completed.error } : {}),
        });
        const recoverOwnedAction = this.ownedActionRecovery(ownedAction);
        if (recoverOwnedAction) {
            recoverOwnedAction(record.requestId);
            return;
        }
        throw new LocalQuestionnaireError(completed.status ?? 503, 'QUESTIONNAIRE_CONTINUATION_NOT_STARTED', `Questionnaire answer was saved, but the continuation could not start${completed.status === undefined ? '.' : ` (HTTP ${completed.status}).`}`);
    }
    /**
     * An owned action's saved answer is resumed by its owner's recovery hook.
     * Without one nothing retries it before the next startup reconciliation, so
     * the caller must see the failure instead of an accepted reply.
     */
    ownedActionRecovery(ownedAction) {
        return ownedAction ? this.deps.onOwnedActionFailure : undefined;
    }
    async finishReply(answeredRecord, reply, ownedAction, completed) {
        if (!completed?.completed || !completed.markInjected)
            return;
        await this.deps.store.markInjected(answeredRecord.requestId, this.deps.nowMs());
        if (completed.admissionMode === 'duplicate') {
            await this.wakeQueueAfterDuplicateResume(answeredRecord);
        }
        if (ownedAction) {
            await this.ownedActionLifecycle.notifyAfterConsumed({
                record: answeredRecord,
                action: { kind: 'reply', reply },
                dispatch: true,
            });
        }
    }
    async requireReplyRecord(requestId, agentName) {
        const record = await this.deps.store.get(requestId);
        if (!record) {
            throw new LocalQuestionnaireError(404, 'QUESTIONNAIRE_NOT_FOUND', 'Questionnaire request not found');
        }
        if (!isQuestionnaireAgentAllowed(record, agentName)) {
            throw new LocalQuestionnaireError(403, 'AGENT_SCOPE_MISMATCH', 'Questionnaire request is not visible to this agent');
        }
        if (record.status === 'answered' && !record.injectedAt && record.replyPayload) {
            return record;
        }
        if (record.status === 'answered') {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', `Questionnaire request is ${record.status}`);
        }
        if (record.status !== 'pending') {
            throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', `Questionnaire request is ${record.status}`);
        }
        return record;
    }
}
export function haveSameAnswers(left, right) {
    return JSON.stringify(canonicalAnswers(left)) === JSON.stringify(canonicalAnswers(right));
}
function canonicalAnswers(reply) {
    return reply.answers
        .map((answer) => ({
        stepId: answer.stepId,
        selectedOptionIds: [...(answer.selectedOptionIds ?? [])].sort(),
        selectedOther: answer.selectedOther === true,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
        skipped: answer.skipped === true,
        ...(answer.contextImages?.length
            ? {
                contextImages: answer.contextImages.map((image) => ({
                    contextId: image.contextId,
                    annotationId: image.annotationId,
                    sha256: image.sha256,
                })),
            }
            : {}),
    }))
        .sort((left, right) => left.stepId.localeCompare(right.stepId));
}
//# sourceMappingURL=generic-reply-lifecycle.js.map