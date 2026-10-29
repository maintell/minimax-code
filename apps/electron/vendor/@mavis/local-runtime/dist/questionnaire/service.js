import { QUESTIONNAIRE_TTL_MS, } from '@mavis/shared/questionnaire';
import { LocalQuestionnaireError } from './errors.js';
import { QuestionnaireValidationError, sanitizeReplyAnswers, validateQuestionnaireReply, } from './normalize.js';
import { isOwnedQuestionnaireRequest, QuestionnaireOwnedActionLifecycle, } from './owned-action-lifecycle.js';
import { QuestionnaireGenericReplyLifecycle } from './generic-reply-lifecycle.js';
import { injectOrdinaryQuestionnaireReply, } from './ordinary-reply-injection.js';
import { isStrandedAnsweredReply } from './reply-fallback.js';
import { expireStaleQuestionnairesOnStartup, recoverQuestionnairesOnStartup, } from './startup-recovery.js';
import { QuestionnaireV2Lifecycle } from './v2-lifecycle.js';
import { isV2Questionnaire } from './v2-state.js';
import { isQuestionnaireAgentAllowed, QuestionnaireRequestLifecycle } from './request-lifecycle.js';
import { QuestionnaireServiceSupport } from './service-support.js';
import { projectQuestionnaireRecord } from './request-view.js';
export { ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS } from './contracts.js';
export { QUESTIONNAIRE_TTL_MS };
export { LocalQuestionnaireError };
export class LocalQuestionnaireService extends QuestionnaireServiceSupport {
    genericReplyLifecycle;
    ownedActionLifecycle;
    requestLifecycle;
    v2Lifecycle;
    constructor(deps) {
        super(deps);
        this.requestLifecycle = new QuestionnaireRequestLifecycle(deps);
        this.v2Lifecycle = new QuestionnaireV2Lifecycle(deps);
        this.ownedActionLifecycle = new QuestionnaireOwnedActionLifecycle(deps, (record, reply, continuationIdentity) => this.injectReply(record, reply, continuationIdentity));
        this.genericReplyLifecycle = new QuestionnaireGenericReplyLifecycle(deps, this.ownedActionLifecycle, (record) => this.wakeQueueAfterDuplicateResume(record));
    }
    async begin(input) {
        return this.requestLifecycle.begin(input);
    }
    async beginOwned(input) {
        return this.requestLifecycle.beginOwned(input);
    }
    async reply(input) {
        const candidate = await this.deps.store.get(input.requestId);
        // Route by the stored column: v2 rows have their own reply rules and are
        // never Goal-owned; legacy rows keep the original Goal / generic paths.
        if (candidate && isV2Questionnaire(candidate))
            return this.v2Lifecycle.reply(input);
        if (Array.isArray(input.reply.answers) &&
            input.reply.answers.some((answer) => answer?.contextImages?.length)) {
            throw new LocalQuestionnaireError(400, 'QUESTIONNAIRE_CONTEXT_IMAGES_UNSUPPORTED', 'Context images require a v2 questionnaire.');
        }
        if (candidate?.request.purpose === 'goal')
            return this.replyOwned(input);
        return this.genericReplyLifecycle.reply(input);
    }
    /** The operations the work owner (the v2 Goal owner) drives for its own requests. */
    ownedOperations() {
        return this.createOwnedOperations((input) => this.reply(input));
    }
    async replyOwned(input) {
        const record = await this.requireMutableRecord(input.requestId, input.agentName, 'reply');
        const session = await this.deps.getSessionById(record.sessionId);
        if (!session) {
            await this.deps.store.delete(record.requestId);
            throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', record.sessionId);
        }
        const workOwner = this.deps.workOwner;
        const admission = workOwner ? await workOwner.admitReply(record) : { current: false };
        if (!admission.current) {
            await this.supersedeStaleOwnedRequest(record, admission.currentOwnerId);
            throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_GOAL_NO_LONGER_CURRENT', 'Questionnaire request no longer belongs to the current Goal');
        }
        let reply;
        try {
            validateQuestionnaireReply(record.request, input.reply);
            reply = {
                schemaVersion: 2,
                requestId: input.reply.requestId,
                answers: sanitizeReplyAnswers(input.reply),
                submittedAt: input.reply.submittedAt,
                source: input.source === 'auto' ? 'automatic_timeout' : 'user',
            };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = err instanceof QuestionnaireValidationError
                ? 'QUESTIONNAIRE_INVALID_REPLY'
                : 'VALIDATION_ERROR';
            throw new LocalQuestionnaireError(400, code, message);
        }
        const releaseInjection = this.tryAcquireReplyInjection(record.requestId);
        if (!releaseInjection) {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_REPLY_IN_FLIGHT', 'Questionnaire reply injection is already in progress');
        }
        try {
            const answeredAt = reply.submittedAt;
            if (input.source === 'auto' && !this.canStartAutoReply(record.sessionId)) {
                throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_AUTO_REPLY_CANCELLED', 'Questionnaire auto reply was cancelled by the runtime lifecycle');
            }
            const won = input.source === 'auto'
                ? await this.deps.store.markAnsweredIfLatestPendingWhen({
                    requestId: record.requestId,
                    sessionId: record.sessionId,
                    answeredAt,
                    replyPayload: reply,
                }, () => workOwner?.acceptsAutomaticAnswer(record) === true)
                : await this.deps.store.markAnswered(record.requestId, answeredAt, reply);
            if (!won)
                await this.throwCurrentTerminalState(record.requestId);
            if (input.source !== 'auto')
                this.deps.autoReplyScheduler?.cancel(record.requestId);
            const injected = await this.injectPersistedReply(record, reply, 'questionnaire.inject_failed', input.source === 'auto');
            this.publishQuestionnaireEvent('questionnaire.dismiss', {
                requestId: record.requestId,
                sessionId: record.sessionId,
                agentName: record.agentName,
                status: 'answered',
            });
            return {
                ok: true,
                requestId: record.requestId,
                sessionId: record.sessionId,
                ...(record.agentName ? { agentName: record.agentName } : {}),
                answeredAt,
                injected,
            };
        }
        finally {
            releaseInjection();
        }
    }
    async dismiss(input) {
        const candidate = await this.deps.store.get(input.requestId);
        // v2 skip/close never marks the row dismissed; it only ends a sync wait.
        if (candidate && isV2Questionnaire(candidate))
            return this.v2Lifecycle.dismiss(input);
        const record = await this.requireDismissibleRecord(input.requestId, input.agentName);
        // Retract before the CAS: a queued degraded reply that the dispatcher
        // already claimed cannot be recalled, and reporting a successful dismiss
        // over an answer that still executes would be a lie. Failing here leaves
        // the record answered and the queue untouched.
        if (record.status === 'answered')
            await this.retractPendingDegradedReply(record);
        const dismissedAt = this.deps.nowMs();
        const ok = await this.deps.store.markDismissed(record.requestId, dismissedAt);
        if (!ok) {
            throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', `Questionnaire request is ${record.status}`);
        }
        if (record.request.purpose === 'goal') {
            this.deps.autoReplyScheduler?.cancel(record.requestId);
        }
        if (isOwnedQuestionnaireRequest(record.request)) {
            try {
                const dismissedRecord = { ...record, status: 'dismissed', dismissedAt };
                const decision = await this.ownedActionLifecycle.route(dismissedRecord, { kind: 'dismiss' }, true);
                if (decision.kind !== 'handled') {
                    throw new Error(`Owned Questionnaire dismiss must be handled for ${record.requestId}`);
                }
                await this.deps.store.markInjected(record.requestId, this.deps.nowMs());
                await this.ownedActionLifecycle.notifyAfterConsumed({
                    record: dismissedRecord,
                    action: { kind: 'dismiss' },
                    dispatch: true,
                });
            }
            catch (error) {
                this.deps.emitBusEvent('questionnaire.inject_failed', {
                    requestId: record.requestId,
                    sessionId: record.sessionId,
                    error: error instanceof Error ? error.message : String(error),
                });
                this.deps.onOwnedActionFailure?.(record.requestId);
            }
        }
        this.deps.publishGlobalEvent?.({
            type: 'questionnaire.dismiss',
            payload: {
                requestId: record.requestId,
                sessionId: record.sessionId,
                agentName: record.agentName,
                status: 'dismissed',
            },
        });
        // Kick the turn-terminal fan-out so `dispatchApiQueuedTurns` /
        // cron BusyQueue / channel drain all get a chance to promote
        // whatever the user enqueued while the ask_user was pending. The
        // reply/answer path drains via its direct resume Turn,
        // but dismiss does not inject a synthetic turn by design — without
        // this explicit kick the session stays idle and queued messages
        // never leave the queue (fires only on hosts that wired the hook).
        this.deps.notifySessionTurnFinished?.(record.sessionId, 'finished');
        return {
            ok: true,
            requestId: record.requestId,
            sessionId: record.sessionId,
            ...(record.agentName ? { agentName: record.agentName } : {}),
            dismissedAt,
        };
    }
    /**
     * A dismiss over an answered-but-uninjected reply must retract the degraded
     * front-of-queue message while it is still undispatched, otherwise the
     * answer the user just dismissed would enter the next Turn anyway. Runs
     * before the dismissed CAS: once the dispatcher claimed the reply the
     * delivery is no longer recallable (409), and a transient queue failure
     * must surface as retryable (503) instead of a false success. A resume that
     * already started keeps winning by settling `injected_at` first, which
     * fails the later CAS.
     */
    async retractPendingDegradedReply(record) {
        const conversation = this.deps.conversation;
        if (!conversation)
            return;
        let claimed = false;
        try {
            const queued = await conversation.ingress.findQueuedByClientRequestId(record.sessionId, `questionnaire-reply:${record.requestId}`);
            if (!queued)
                return;
            claimed =
                (await conversation.ingress.cancelQueued(record.sessionId, queued.itemId)) ===
                    'not_editable';
        }
        catch (err) {
            throw new LocalQuestionnaireError(503, 'QUESTIONNAIRE_REPLY_RETRACT_FAILED', `Queued reply could not be retracted: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (claimed) {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_REPLY_DELIVERING', 'The answered reply is already being delivered to the next Turn');
        }
    }
    async getPending(input) {
        const record = await this.requestLifecycle.getPending(input);
        return record ? projectQuestionnaireRecord(this.deps, record) : null;
    }
    /** getPending `includeUnanswered`: every unanswered v2 questionnaire, newest first. */
    async listUnansweredV2(input) {
        return (await this.v2Lifecycle.listUnanswered(input)).map((record) => projectQuestionnaireRecord(this.deps, record));
    }
    /** v2 Turn system hook: the answer reached the model (admission, consumption or teardown). */
    async markAnswerAdmitted(input) {
        return this.v2Lifecycle.markAnswerAdmitted(input);
    }
    async snapshotUnresolvedForRewind(sessionId) {
        const records = await this.deps.store.findUnresolvedForRewind(sessionId);
        return records.map((record) => record.requestId);
    }
    async cancelUnresolvedForRewind(input) {
        const deleted = await this.deps.store.deleteUnresolvedForRewind(input);
        deleted.forEach((record) => this.deps.publishGlobalEvent?.({
            type: 'questionnaire.dismiss',
            payload: {
                requestId: record.requestId,
                sessionId: record.sessionId,
                agentName: record.agentName,
                status: 'dismissed',
            },
        }));
    }
    async get(input) {
        const record = await this.requestLifecycle.get(input);
        return record ? projectQuestionnaireRecord(this.deps, record) : null;
    }
    async getLatestPlanReview(input) {
        return this.requestLifecycle.getLatestPlanReview(input);
    }
    /** Recover unowned requests; the work owner recovers its own (see `ownedOperations`). */
    async recoverOnStartup(options = {}) {
        return recoverQuestionnairesOnStartup({
            deps: this.deps,
            injectReply: (record, reply) => this.injectReply(record, reply),
            recoverV2Answer: (record) => this.v2Lifecycle.recoverAnswer(record),
            wakeQueueAfterDuplicateResume: (record) => this.wakeQueueAfterDuplicateResume(record),
            ...options,
        });
    }
    /** Expire stale unowned pending requests only; `recoverOnStartup` repeats it idempotently. */
    async expireOnStartup(options = {}) {
        return expireStaleQuestionnairesOnStartup({ deps: this.deps, ...options });
    }
    async reconcileOwnedActions(dispatch) {
        return this.ownedActionLifecycle.reconcile(dispatch);
    }
    injectReply(record, reply, continuationIdentityOrAutomatic) {
        return injectOrdinaryQuestionnaireReply(this.deps, record, reply, continuationIdentityOrAutomatic);
    }
    async wakeQueueAfterDuplicateResume(record) {
        try {
            await this.deps.conversation?.ingress.dispatchQueue(record.sessionId);
        }
        catch (err) {
            this.deps.emitBusEvent('questionnaire.queue_wake_failed', {
                requestId: record.requestId,
                sessionId: record.sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    async requireDismissibleRecord(requestId, agentName) {
        const record = await this.deps.store.get(requestId);
        if (!record) {
            throw new LocalQuestionnaireError(404, 'QUESTIONNAIRE_NOT_FOUND', 'Questionnaire request not found');
        }
        if (!isQuestionnaireAgentAllowed(record, agentName)) {
            throw new LocalQuestionnaireError(403, 'AGENT_SCOPE_MISMATCH', 'Questionnaire request is not visible to this agent');
        }
        if (record.status === 'pending' &&
            record.createdAt < this.deps.nowMs() - QUESTIONNAIRE_TTL_MS) {
            await this.deps.store.expirePendingRequest(record.requestId, this.deps.nowMs() - QUESTIONNAIRE_TTL_MS);
            throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', 'Questionnaire request is expired');
        }
        if (record.status === 'answered') {
            if (isStrandedAnsweredReply(record))
                return record;
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', `Questionnaire request is ${record.status}`);
        }
        if (record.status !== 'pending') {
            throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', `Questionnaire request is ${record.status}`);
        }
        return record;
    }
}
//# sourceMappingURL=service.js.map