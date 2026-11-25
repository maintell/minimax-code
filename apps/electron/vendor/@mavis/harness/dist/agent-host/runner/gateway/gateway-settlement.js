import { TurnVisibleTextWatch } from '../observability/turn-visible-text.js';
import { appendSafetyReplacement } from '../output/safety-replacement.js';
import { deriveLocalTurnRuntimeOutcome } from '../turn-outcome.js';
import { appendCancelledTurn, appendSyntheticCompleted, recallAttempt, } from '../turn-runner-support.js';
export function createGatewayRunnerState(input) {
    let eventIdentitySequence = 0;
    let runtimeSequence = 0;
    return {
        inputAccepted: false,
        retracted: false,
        networkStopped: false,
        ptcSafetyStopped: false,
        replyWithdrawn: false,
        steeringJoined: false,
        recallSequence: 0,
        finalAttemptEventStart: input.eventWriter.events.length,
        visibleText: new TurnVisibleTextWatch(input.turnTiming !== undefined),
        eventIdGenerator: input.eventIdGenerator ??
            ((kind) => `evt_${input.turnId}_${kind}_${++eventIdentitySequence}`),
        runtimeSeqGenerator: input.runtimeSeqGenerator ?? (() => ++runtimeSequence),
    };
}
/**
 * 按网关的打回结果收尾。用户中止优先；输出被拦（判拦截或引导次数用完）只删被拦的这一条，
 * PTC 回合和非 PTC 回合一样，用户在本机输入的轮次撤掉这一条后什么都不剩时改为整轮撤回（见
 * `settleWithdrawnReply`）；
 * 其余（输入被拦、固答）本轮跑过 PTC 子操作时沿用 PTC 停止流程保留执行事实，否则按结果走整轮撤回或固答。
 */
export async function settleGatewayTurn(scope, outcome) {
    const { input, state, writer } = scope;
    if (input.signal?.aborted) {
        // 被打回的那条已经撤掉、也不算已显示的部分，其余照常按中止落库。
        if (outcome)
            await recallRejectedMessage(input, state, writer, outcome.assistantMessageId);
        state.approvedPartial = writer.getApprovedPartial();
        await appendCancelledTurn(input, state);
        return;
    }
    if (!outcome) {
        state.approvedPartial = writer.getApprovedPartial();
        return;
    }
    if (isWithdrawnReply(outcome, writer)) {
        await settleWithdrawnReply(scope, outcome);
        return;
    }
    if (writer.hasPtcChildCalls()) {
        await recallRejectedMessage(input, state, writer, outcome.assistantMessageId);
        state.ptcSafetyStopped = true;
        await settleOutputRetraction(input, state);
        return;
    }
    if (outcome.kind === 'replace' && outcome.suggestion?.trim()) {
        await settleReplacement(input, state, writer, outcome.suggestion);
        return;
    }
    // recall、exhausted，以及没给固答文本的 replace：整轮撤回。
    await settleOutputRetraction(input, state);
}
/**
 * 网关打回某条回复时的处理（agent-core 会等它返回）：
 * - `regenerate`：只撤回界面上这一条，agent-core 随后带引导词重发同一次模型调用；
 * - 终止类结果：丢弃之后的帧（包括 Pi 的终态帧），用现有的中止原因结束本轮，
 *   runTurn 返回后由 `settleGatewayTurn` 按结果收尾。
 * 单条撤回失败时同样结束本轮，runTurn 返回后把失败抛出去。
 */
export async function onContentRejected(scope) {
    const { input, state, writer, turnAbort, observation, rejection } = scope;
    try {
        // 被打回那条之前的帧先送达，撤回边界才能排在它们后面。
        await writer.drain();
        if (rejection.kind === 'regenerate') {
            observation.regenerations += 1;
            await recallRejectedMessage(input, state, writer, rejection.assistantMessageId);
            return;
        }
    }
    catch (error) {
        state.recallFailure ??= { error };
    }
    writer.block();
    turnAbort.abort('output_safety');
}
/**
 * 输出被拦：被拦那条已经下发过内容帧，并且判拦截或引导次数用完。输入被拦时网关不把请求转给模型，
 * 被拦那条一帧都没有，走原来的处理。要在撤回这一条之前判断。
 */
function isWithdrawnReply(outcome, writer) {
    return ((outcome.kind === 'recall' || outcome.kind === 'exhausted') &&
        outcome.assistantMessageId !== undefined &&
        writer.hasMessage(outcome.assistantMessageId));
}
/**
 * 输出被拦的收尾：撤掉被拦的这一条后本轮还有别的内容，就只撤这一条；用户在本机输入的轮次什么都不剩时
 * （本轮第一次模型调用就被拦，或者前几次重新生成都已撤掉），这一轮只剩一条没人回答的用户消息，改为和
 * 输入被拦一样整轮撤回：删掉用户消息、放回原话，本轮显示过的内容（包括被拦的这一条）由执行器按 reconcile
 * 一起撤掉。整轮撤回前不再单条撤回：多发一次 rewind 会让界面多拉一次消息，这次拉取晚于整轮删除返回时，
 * 界面找不到用户消息，放回原话时附件会丢。
 */
async function settleWithdrawnReply(scope, outcome) {
    const { input, state, writer } = scope;
    if (!keepsOtherContent(input, state, writer, outcome.assistantMessageId)) {
        await settleOutputRetraction(input, state);
        return;
    }
    await recallRejectedMessage(input, state, writer, outcome.assistantMessageId);
    await settleReplyWithdrawn(input, state, outcome, scope.logger);
}
/**
 * 撤掉这一条之后本轮还有没有要保留的内容。拿不准的都算有，只撤这一条：
 * - 不是用户在本机输入的轮次（宿主没说也算）：后台任务结果、IM 原文、定时任务、子会话任务说明、目标续跑
 *   这类触发消息被整轮撤回后就永久没了，也放不回输入框；
 * - 续跑的轮次：之前那次运行留下的内容这里看不到，整轮撤回会把它们一起删掉；
 * - 有插话进来的轮次：整轮撤回会把插话一起删掉，也放不回输入框。
 */
function keepsOtherContent(input, state, writer, messageId) {
    if (input.userTypedTurn !== true)
        return true;
    const continuation = input.startMode !== undefined && input.startMode !== 'prompt';
    return continuation || state.steeringJoined || writer.hasKeptMessageOtherThan(messageId);
}
/** 只撤回界面上被打回的这一条；它没有任何帧下发过（网关在上游返回前就打回）时无事可做。 */
async function recallRejectedMessage(input, state, writer, messageId) {
    if (!messageId || !writer.hasMessage(messageId))
        return;
    writer.forgetMessage(messageId);
    if (!input.onOutputRecall) {
        throw new Error('Output recall Display retraction is unavailable.');
    }
    state.recallSequence += 1;
    await input.onOutputRecall({
        attempt: state.recallSequence,
        messageIds: [messageId],
        messagesOnly: true,
    });
}
/**
 * 网关要求固答：沿用原输入固答的写入管道，先撤回本轮已输出的内容（本轮第一次模型调用就被固答时
 * 就是被打回的这一条），再把用户消息和固答写进历史与界面，以 completed 结束本轮。
 */
async function settleReplacement(input, state, writer, text) {
    state.recallSequence += 1;
    await recallAttempt(input, writer, state.recallSequence);
    if (!(await appendSafetyReplacement(input, text, state))) {
        await appendCancelledTurn(input, state);
    }
}
/**
 * 输出被拦：界面上的这一条已经撤掉；用户消息和本轮之前的步骤（工具调用、工具结果、之前的回复）
 * 都保留，不把原话放回输入框，以 completed 结束本轮，由 reconcile 通知界面提示。
 */
async function settleReplyWithdrawn(input, state, outcome, logger) {
    logger?.info?.({
        sessionId: input.sessionId,
        turnId: input.turnId,
        reviewOutcome: outcome.kind,
        outputSuppressed: true,
        terminalStatus: 'completed',
    }, '[content-safety] output review withdrew the reply');
    state.replyWithdrawn = true;
    await appendSyntheticCompleted(input, `local-output-reply-withdrawn-${input.turnId}-status`);
}
async function settleOutputRetraction(input, state) {
    state.retracted = true;
    state.retractionVariant = 'content';
    await appendSyntheticCompleted(input, `local-output-retracted-${input.turnId}-status`);
}
export function buildGatewayRunnerResult(input, state) {
    const events = input.eventWriter.events;
    const outcome = deriveLocalTurnRuntimeOutcome(events);
    const reconcile = deriveReconcile(state, outcome.status);
    const hasRetractionVariant = (state.retracted || state.networkStopped) && state.retractionVariant;
    return {
        events,
        retracted: state.retracted,
        networkStopped: state.networkStopped,
        ...(state.replyWithdrawn ? { replyWithdrawn: true } : {}),
        outcome,
        ...(reconcile ? { reconcile } : {}),
        ...(hasRetractionVariant ? { retractionVariant: state.retractionVariant } : {}),
        ...(state.approvedPartial ? { approvedPartial: state.approvedPartial } : {}),
        ...(state.finalAttemptEventStart > 0
            ? { timingEventsStartIndex: state.finalAttemptEventStart }
            : {}),
    };
}
function deriveReconcile(state, status) {
    if (state.replyWithdrawn)
        return { kind: 'reply-reconcile' };
    if (state.ptcSafetyStopped)
        return { kind: 'safety-reconcile', approvedContent: '' };
    if (state.retracted) {
        return {
            kind: 'output-recall',
            source: 'output-review',
            variant: state.retractionVariant ?? 'content',
        };
    }
    if (state.networkStopped) {
        return { kind: 'network-reconcile', approvedContent: state.approvedPartial?.content };
    }
    if (status === 'aborted') {
        return { kind: 'abort-reconcile', approvedContent: state.approvedPartial?.content };
    }
    return undefined;
}
//# sourceMappingURL=gateway-settlement.js.map