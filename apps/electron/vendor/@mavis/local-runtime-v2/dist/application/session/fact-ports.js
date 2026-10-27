import { QueueCommittedEventProjector } from '../queue/queue-application.js';
import { SessionLifecycleEventProjector } from './lifecycle-application.js';
import { RootArchiveTitleEventProjector } from './root-application.js';
/** Preserves write-before-event ordering for model selection composed before SessionLifecycleService. */
export function createCommittedModelProviderSessionPort(input) {
    return {
        get: input.get,
        update: async (sessionId, fields, notice) => {
            const updated = await input.update(sessionId, fields);
            input.onCommittedUpdate(updated, notice?.replacedFrom);
            return updated;
        },
    };
}
export function publishSessionCompactionFact(publish, fact) {
    if (fact.kind === 'started') {
        publish({
            type: 'session.compaction.started',
            payload: { sessionId: fact.sessionId, compactionId: fact.attemptId },
        });
        return;
    }
    if (fact.kind === 'completed') {
        publish({
            type: 'session.compaction.completed',
            payload: {
                sessionId: fact.sessionId,
                compactionId: fact.attemptId,
                messagesBefore: fact.messagesBefore,
                messagesAfter: fact.messagesAfter,
                tokensBefore: fact.tokensBefore,
                tokensAfter: fact.tokensAfter,
                ...(fact.tokenUsage === undefined ? {} : { tokenUsage: fact.tokenUsage }),
            },
        });
        return;
    }
    publish({
        type: 'session.compaction.failed',
        payload: {
            sessionId: fact.sessionId,
            compactionId: fact.attemptId,
            ...(fact.tokenUsage === undefined ? {} : { tokenUsage: fact.tokenUsage }),
        },
    });
}
/** Projects v2-owned committed facts directly into the v2 EventBus. */
export function createApplicationFactPorts(options) {
    const sessionEvents = new SessionLifecycleEventProjector({ publish: options.publish });
    const queueEvents = new QueueCommittedEventProjector({ publish: options.publish });
    const archiveTitleEvents = new RootArchiveTitleEventProjector({ publish: options.publish });
    return {
        session: {
            handle: (fact) => sessionEvents.handle(fact),
        },
        queue: {
            handle: (facts) => queueEvents.handle(facts),
        },
        conversation: {
            handle: async (fact) => {
                if (fact.kind === 'attempt-recalled') {
                    options.publish({
                        type: 'message.rewind',
                        payload: { sessionId: fact.sessionId, contextReset: true },
                    });
                    return;
                }
                if (fact.kind === 'network-stopped') {
                    options.publish({
                        type: 'content.retry.exceeded',
                        payload: {
                            sessionId: fact.sessionId,
                            turnId: fact.turnId,
                            variant: 'network',
                            ...(fact.slowNetworkRead ? { slowNetworkRead: true } : {}),
                        },
                    });
                    return;
                }
                const reopenedQuestionnaireRequestId = await reopenWithdrawnQuestionnaire(options, fact);
                const clearedGoal = await deleteWithdrawnGoal(options, fact);
                options.publish({
                    type: 'content.retry.exceeded',
                    payload: retractionPayload(fact, reopenedQuestionnaireRequestId, clearedGoal),
                });
                options.publish({
                    type: 'message.rewind',
                    payload: { sessionId: fact.sessionId, contextReset: true },
                });
            },
        },
        archiveTitle: {
            observe: async (fact) => {
                archiveTitleEvents.observe(fact);
            },
        },
    };
}
/**
 * 普通问卷的回答因内容违规被撤回时，重开问卷让用户再答一次，不往输入框里填。
 * 网络和鉴权导致的停止沿用各自的恢复方式。重开失败就退回成普通的「已撤回」提示：
 * 撤回事件本身必须照常送到客户端。
 */
async function reopenWithdrawnQuestionnaire(options, fact) {
    if (fact.variant !== 'content' || !fact.questionnaireRequestId)
        return undefined;
    const input = {
        sessionId: fact.sessionId,
        turnId: fact.turnId,
        requestId: fact.questionnaireRequestId,
    };
    try {
        return await options.questionnaires?.reopenAfterSafetyRecall(input);
    }
    catch (error) {
        options.logger?.warn({ ...input, reason: error instanceof Error ? error.message : String(error) }, 'safety recall questionnaire reopen failed');
        return undefined;
    }
}
/**
 * 目标第一轮因内容违规被撤回时删掉这个目标，客户端就能把 `/goal` 放回输入框修改；
 * 这一轮之后被替换或改过描述的目标不删。删除失败就保留目标，退回成普通的「已撤回」
 * 提示：撤回事件本身必须照常送到客户端。
 */
async function deleteWithdrawnGoal(options, fact) {
    if (fact.variant !== 'content' || !fact.goalKickoff)
        return undefined;
    const input = { sessionId: fact.sessionId, turnId: fact.turnId, ...fact.goalKickoff };
    try {
        return await options.goals?.deleteGoalAfterKickoffRecall(input);
    }
    catch (error) {
        options.logger?.warn({ ...input, reason: error instanceof Error ? error.message : String(error) }, 'safety recall goal deletion failed');
        return undefined;
    }
}
function retractionPayload(fact, reopenedQuestionnaireRequestId, clearedGoal) {
    // 目标第一轮只有在目标删掉后才以 `/goal` 放回；目标还在，客户端就没有可放回的。
    const lastUserContent = fact.goalKickoff && !clearedGoal ? undefined : fact.lastUserContent;
    return {
        sessionId: fact.sessionId,
        variant: fact.variant,
        turnId: fact.turnId,
        ...(fact.lastUserMsgId ? { lastUserMsgId: fact.lastUserMsgId } : {}),
        ...(lastUserContent !== undefined ? { lastUserContent } : {}),
        ...(fact.slowNetworkRead ? { slowNetworkRead: true } : {}),
        ...(reopenedQuestionnaireRequestId ? { reopenedQuestionnaireRequestId } : {}),
        ...(clearedGoal ? { clearedGoal } : {}),
    };
}
//# sourceMappingURL=fact-ports.js.map