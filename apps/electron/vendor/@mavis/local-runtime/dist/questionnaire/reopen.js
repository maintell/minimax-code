import { createHash } from 'node:crypto';
import { ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS, } from './contracts.js';
/**
 * 内容安审撤回普通问卷的回答后，重开这份问卷。
 *
 * 已回答的原记录不动。新建一份待回答的问卷，把被撤回的答案作为预填。它由 runtime
 * 创建，所以去掉原来的工具调用身份；也不会回到 IM：不复制原来的渠道上下文，启动
 * 恢复重发问卷时渠道投递也会跳过它。
 */
export async function reopenQuestionnaireAfterSafetyRecall(deps, input) {
    const source = await deps.store.get(input.requestId);
    const answers = source && reopenableAnswers(source, input.sessionId);
    if (!source || !answers)
        return undefined;
    const requestId = safetyRecallRequestId(input.turnId, source.requestId);
    const existing = await deps.store.get(requestId);
    if (existing) {
        if (existing.status !== 'pending')
            return undefined;
        publishAsk(deps, existing, 'recovery');
        return existing;
    }
    const createdAt = deps.nowMs();
    const agentName = source.agentName ?? source.request.requester?.agentName;
    // The original tool wait is over; a recalled v2 answer starts an independent async request.
    const responseMode = source.responseMode ? 'async' : undefined;
    const request = {
        ...source.request,
        id: requestId,
        status: 'pending',
        createdAt,
        reopenReason: 'content_recall',
        prefillAnswers: structuredClone(answers),
        requester: {
            sessionId: source.sessionId,
            ...(agentName ? { agentName } : {}),
        },
    };
    delete request.tool;
    delete request.responseMode;
    delete request.countdownSeconds;
    delete request.syncWaiting;
    delete request.originTurnRunning;
    delete request.answeredAt;
    delete request.injectedAt;
    delete request.expiresAt;
    delete request.blockingExpiresAt;
    if (responseMode) {
        request.responseMode = responseMode;
        request.countdownSeconds = ASYNC_QUESTIONNAIRE_COUNTDOWN_SECONDS;
    }
    const record = {
        requestId,
        sessionId: source.sessionId,
        ...(agentName ? { agentName } : {}),
        request,
        ...(responseMode ? { responseMode } : {}),
        status: 'pending',
        createdAt,
    };
    await deps.store.upsert(record);
    publishAsk(deps, record, 'created');
    return record;
}
function reopenableAnswers(record, sessionId) {
    const ordinary = (record.request.mode ?? 'questionnaire') === 'questionnaire' &&
        record.request.purpose !== 'goal';
    return record.sessionId === sessionId && record.status === 'answered' && ordinary
        ? record.replyPayload?.answers
        : undefined;
}
function publishAsk(deps, record, deliveryReason) {
    deps.publishGlobalEvent?.({
        type: 'questionnaire.ask',
        payload: {
            requestId: record.requestId,
            sessionId: record.sessionId,
            agentName: record.agentName,
            request: record.request,
            deliveryReason,
        },
    });
}
function safetyRecallRequestId(turnId, sourceRequestId) {
    const identity = createHash('sha256')
        .update(turnId)
        .update('\0')
        .update(sourceRequestId)
        .digest('hex')
        .slice(0, 24);
    return `ask_reopen_${identity}`;
}
//# sourceMappingURL=reopen.js.map