/**
 * Resolve a Goal questionnaire timeout through the same durable reply and
 * conversation-ingress path as a user submission. `retry` asks the timer to
 * retry only the already-persisted Turn injection; the selected answers never
 * change between attempts. Automatic answers require the Goal to be active.
 */
export async function autoReplyGoalQuestionnaire(requestId, context) {
    const { questionnaires } = context;
    const record = await questionnaires.get(requestId);
    if (!record || record.request.purpose !== 'goal')
        return 'done';
    if (!questionnaires.canStartAutoReply(record.sessionId))
        return 'done';
    if (!(await isOwnedByActiveGoal(record, context)))
        return 'done';
    const latest = await questionnaires.findLatestBySession(record.sessionId);
    if (latest?.requestId !== record.requestId) {
        // A timeout claim can have durably answered this request while waiting
        // for turn admission. If a newer questionnaire replaces it during that
        // window, the old reply must never retry and its originating IM card
        // must leave the adapter's pending map.
        await questionnaires.supersedeReplaced(record, latest?.requestId);
        return 'done';
    }
    if (record.status === 'answered')
        return reinjectSavedAnswer(record, questionnaires);
    if (record.status !== 'pending')
        return 'done';
    return answerExpiredRequest(record, context);
}
/** Retires a request whose Goal changed or completed; holds one whose Goal is not active. */
async function isOwnedByActiveGoal(record, context) {
    if (!record.request.goalId) {
        await context.questionnaires.supersedeStale(record);
        return false;
    }
    const goal = await context.readGoal(record.sessionId);
    if (!goal || goal.goalId !== record.request.goalId || goal.status === 'complete') {
        await context.questionnaires.supersedeStale(record, goal?.goalId);
        return false;
    }
    if (goal.status !== 'active') {
        context.timers.cancel(record.requestId);
        return false;
    }
    return true;
}
/** Saving the answer is not the same as continuing: only the injection is retried. */
async function reinjectSavedAnswer(record, questionnaires) {
    if (record.injectedAt !== undefined || !record.replyPayload)
        return 'done';
    const releaseInjection = questionnaires.tryAcquireReplyInjection(record.requestId);
    if (!releaseInjection)
        return 'done';
    try {
        if (!(await questionnaires.hasSession(record.sessionId))) {
            await questionnaires.delete(record.requestId);
            return 'done';
        }
        const injected = await questionnaires.injectPersistedReply(record, record.replyPayload, 'questionnaire.auto_reply_inject_failed', true);
        return injected ? 'done' : 'retry';
    }
    finally {
        releaseInjection();
    }
}
async function answerExpiredRequest(record, context) {
    const latestPending = await context.questionnaires.findLatestPendingBySession(record.sessionId);
    if (latestPending?.requestId !== record.requestId)
        return 'done';
    const expiresAt = record.request.expiresAt;
    if (expiresAt === undefined)
        return 'done';
    if (expiresAt > context.nowMs()) {
        context.timers.schedule(record);
        return 'done';
    }
    return submitRecommendedReply(record, context);
}
async function submitRecommendedReply(record, context) {
    const { questionnaires } = context;
    const reply = recommendedReply(record, context.nowMs);
    try {
        const result = await questionnaires.reply({
            agentName: record.agentName ?? questionnaires.primaryAgentName,
            requestId: record.requestId,
            reply,
            source: 'auto',
        });
        questionnaires.emitBusEvent('questionnaire.auto_replied', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            answeredAt: result.answeredAt,
        });
        return result.injected ? 'done' : 'retry';
    }
    catch (err) {
        if (questionnaires.isSettledReplyError(err))
            return 'done';
        questionnaires.emitBusEvent('questionnaire.auto_reply_failed', {
            requestId: record.requestId,
            sessionId: record.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
        return 'retry';
    }
}
/** Each step takes its recommended option, else its first option, else is skipped. */
function recommendedReply(record, nowMs) {
    return {
        schemaVersion: 2,
        requestId: record.requestId,
        answers: record.request.steps.map((step) => {
            const recommended = step.options.find((option) => option.recommended === true);
            const selected = recommended ?? step.options[0];
            return selected
                ? { stepId: step.id, selectedOptionIds: [selected.id], selectedOther: false }
                : { stepId: step.id, selectedOptionIds: [], selectedOther: false, skipped: true };
        }),
        submittedAt: nowMs(),
    };
}
//# sourceMappingURL=goal-questionnaire-auto-reply.js.map