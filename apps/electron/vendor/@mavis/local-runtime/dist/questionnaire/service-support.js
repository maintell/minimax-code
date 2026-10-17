import { serializeQuestionnaireResponseMessage } from './serializer.js';
import { LocalQuestionnaireError } from './errors.js';
export class QuestionnaireServiceSupport {
    deps;
    localReplyInjections = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    async injectGoalReply(record, reply) {
        const goalId = record.request.goalId;
        if (!goalId) {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_GOAL_OWNER_MISSING', 'Goal questionnaire is missing its owning Goal identity');
        }
        const message = {
            content: serializeQuestionnaireResponseMessage(record.request, reply, this.deps.resolveLocale?.()),
            attachments: [],
            ...(record.originChannelContext ? { channelContext: record.originChannelContext } : {}),
        };
        if (!this.deps.conversation) {
            throw new LocalQuestionnaireError(503, 'CONVERSATION_UNAVAILABLE', 'Runtime Conversation is unavailable for questionnaire reply');
        }
        const injectionId = `questionnaire-reply:${record.requestId}`;
        const resumeUserInput = this.deps.conversation.ingress.resumeUserInput?.bind(this.deps.conversation.ingress);
        if (resumeUserInput) {
            await resumeUserInput({
                sessionId: record.sessionId,
                source: 'questionnaire',
                requestId: record.requestId,
                owner: { kind: 'thread-goal', goalId },
                message,
            });
            return { completed: true };
        }
        await this.deps.conversation.ingress.submit({
            sessionId: record.sessionId,
            source: 'questionnaire',
            // Compatibility fallback for runtimes that predate resumeUserInput.
            // A questionnaire response must never enter the ordinary Queue.
            allowQueue: false,
            clientRequestId: injectionId,
            dedupeKey: injectionId,
            message,
        });
        return { completed: true };
    }
    async requireMutableRecord(requestId, agentName, action) {
        const record = await this.deps.store.get(requestId);
        if (!record) {
            throw new LocalQuestionnaireError(404, 'QUESTIONNAIRE_NOT_FOUND', 'Questionnaire request not found');
        }
        if (!this.isAgentAllowed(record, agentName)) {
            throw new LocalQuestionnaireError(403, 'AGENT_SCOPE_MISMATCH', 'Questionnaire request is not visible to this agent');
        }
        if (record.status === 'answered') {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', `Questionnaire request is ${record.status}`);
        }
        if (record.status !== 'pending') {
            throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', `Questionnaire request is ${record.status}`);
        }
        void action;
        return record;
    }
    async throwCurrentTerminalState(requestId) {
        const current = await this.deps.store.get(requestId);
        if (!current) {
            throw new LocalQuestionnaireError(404, 'QUESTIONNAIRE_NOT_FOUND', 'Questionnaire request not found');
        }
        if (current.status === 'answered') {
            throw new LocalQuestionnaireError(409, 'QUESTIONNAIRE_ALREADY_ANSWERED', `Questionnaire request is ${current.status}`);
        }
        throw new LocalQuestionnaireError(410, 'QUESTIONNAIRE_NOT_PENDING', `Questionnaire request is ${current.status}`);
    }
    async injectPersistedReply(record, reply, failureEvent, automatic = false) {
        try {
            // Fast-path lifecycle check before entering runtime-owned admission.
            // Automatic retries revalidate Goal identity in autoReply().
            if (automatic && !this.canStartAutoReply(record.sessionId))
                return false;
            const replyForMessage = reply.source || !automatic ? reply : { ...reply, source: 'automatic_timeout' };
            const result = await this.injectGoalReply(record, replyForMessage);
            if (!result.completed) {
                this.deps.emitBusEvent(failureEvent, {
                    requestId: record.requestId,
                    sessionId: record.sessionId,
                    ...(result.status !== undefined ? { status: result.status } : {}),
                    ...(result.error ? { error: result.error } : {}),
                });
                return false;
            }
            await this.deps.store.markInjected(record.requestId, this.deps.nowMs());
            return true;
        }
        catch (err) {
            // Do not roll back the answered row. The persisted reply_payload is the
            // recovery source of truth and startup/scheduler recovery retries it.
            this.deps.emitBusEvent(failureEvent, {
                requestId: record.requestId,
                sessionId: record.sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }
    isAgentAllowed(record, agentName) {
        const owner = record.agentName ?? record.request.requester?.agentName;
        if (!owner || owner === agentName)
            return true;
        return false;
    }
    canStartAutoReply(sessionId) {
        return this.deps.canStartAutoReply?.(sessionId) !== false;
    }
    tryAcquireReplyInjection(requestId) {
        if (this.deps.tryAcquireReplyInjection) {
            return this.deps.tryAcquireReplyInjection(requestId);
        }
        if (this.localReplyInjections.has(requestId))
            return undefined;
        this.localReplyInjections.add(requestId);
        return () => this.localReplyInjections.delete(requestId);
    }
    async supersedeStaleGoalRequest(record, currentGoalId) {
        this.deps.autoReplyScheduler?.cancel(record.requestId);
        const superseded = await this.markUninjectedRecordSuperseded(record);
        if (!superseded)
            return;
        this.publishQuestionnaireEvent('questionnaire.superseded', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            agentName: record.agentName,
            goalId: record.request.goalId,
            ...(currentGoalId ? { currentGoalId } : {}),
            supersededAt: this.deps.nowMs(),
        });
    }
    async supersedeReplacedQuestionnaire(record, keepRequestId) {
        this.deps.autoReplyScheduler?.cancel(record.requestId);
        const superseded = await this.markUninjectedRecordSuperseded(record);
        if (!superseded)
            return;
        this.publishQuestionnaireEvent('questionnaire.superseded', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            agentName: record.agentName,
            goalId: record.request.goalId,
            ...(keepRequestId ? { keepRequestId } : {}),
            supersededAt: this.deps.nowMs(),
        });
    }
    markUninjectedRecordSuperseded(record) {
        if (record.status !== 'pending' &&
            (record.status !== 'answered' || record.injectedAt !== undefined)) {
            return Promise.resolve(false);
        }
        return this.deps.store.markSuperseded(record.requestId);
    }
    publishQuestionnaireEvent(type, payload) {
        // Keep the bus event for legacy channel consumers while also projecting
        // the same lifecycle to the current global-event stream used by the UI.
        this.deps.emitBusEvent(type, payload);
        this.deps.publishGlobalEvent?.({ type, payload });
    }
    emitAsk(record) {
        this.publishQuestionnaireEvent('questionnaire.ask', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            agentName: record.agentName,
            request: record.request,
        });
        void Promise.resolve(this.deps.onQuestionnaireAsk?.(record)).catch((err) => {
            this.deps.emitBusEvent('questionnaire.delivery_failed', {
                requestId: record.requestId,
                sessionId: record.sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }
}
//# sourceMappingURL=service-support.js.map