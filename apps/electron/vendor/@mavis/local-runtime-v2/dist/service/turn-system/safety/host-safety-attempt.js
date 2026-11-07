import { buildAbortedTerminalStatusEvent, buildCompletedTerminalStatusEvent, } from '@mavis/agent-core/event-bridge';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import { logger } from '../../../infra/logging/logger.js';
import { writeSafetyReplacement } from './safety-replacement.js';
/** 仅消费本次 attempt 的结果；裁定优先级与事件写入顺序保持在同一处。 */
export async function finishSafetyAttempt(input) {
    const { turn, inputSafety, writer } = input;
    if (needsCancelledTerminal(turn, input.eventStart))
        return { kind: 'cancel', approvedPartial: writer.getApprovedPartial() };
    if (inputSafety.rejected) {
        await completeSafetyTurn(turn, 'input-retracted');
        return {
            kind: 'finish',
            output: { retracted: true, networkStopped: false, retractionVariant: inputSafety.variant },
        };
    }
    if (needsInputCorrection(inputSafety, writer))
        return correctInput(turn, inputSafety);
    // 网络软停必须先于 blocked，避免把审核不可用变成内容撤回。
    if (writer.networkStopped)
        return finishNetworkStop(turn, writer);
    const guideReviewed = writer.guideReviewed;
    const blocked = writer.blocked;
    const guide = guideReviewed ? writer.consumeGuidePrompt() : undefined;
    if (!blocked && !guideReviewed) {
        return {
            kind: 'finish',
            output: {
                retracted: false,
                networkStopped: false,
                approvedPartial: writer.getApprovedPartial(),
            },
        };
    }
    if (writer.immediateBlock || input.regenerationCount >= input.maxRegenerations) {
        await completeSafetyTurn(turn, 'output-retracted');
        return {
            kind: 'finish',
            output: { retracted: true, networkStopped: false, retractionVariant: 'content' },
        };
    }
    await turn.onOutputRecall?.();
    await turn.rewindPiHistory?.();
    return { kind: 'retry', guide };
}
function needsCancelledTerminal(turn, eventStart) {
    return Boolean(turn.signal?.aborted &&
        !turn.eventWriter.events
            .slice(eventStart)
            .some((event) => event.type === RuntimeEventType.SESSION_STATUS &&
            event.payload?.status === RuntimeEventStatus.ABORTED));
}
function needsInputCorrection(state, writer) {
    return Boolean(state.correctionPending && (state.replacement || !writer.immediateBlock));
}
async function correctInput(turn, state) {
    await turn.onOutputRecall?.();
    await turn.rewindPiHistory?.();
    if (state.replacement) {
        if (!(await writeSafetyReplacement(turn, state.replacement)))
            return { kind: 'cancel' };
        return { kind: 'finish', output: { retracted: false, networkStopped: false } };
    }
    if (turn.signal?.aborted)
        return { kind: 'cancel' };
    state.correctionPending = false;
    // 晚到输入 guide 的纠正不占用输出重生预算。
    return { kind: 'retry', guide: state.guide, inputCorrection: true };
}
async function finishNetworkStop(turn, writer) {
    // runner FAILED 已透传，比同时发生的安审网络失败更具体。
    if (writer.terminalFailed)
        return { kind: 'finish', output: { retracted: false, networkStopped: false } };
    logger.warn({
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        reviewOutcome: 'unavailable',
        outputSuppressed: true,
        terminalStatus: 'completed',
    }, '[content-safety] output review stopped turn');
    const approvedPartial = writer.getApprovedPartial();
    await completeSafetyTurn(turn, 'output-network-stopped');
    return {
        kind: 'finish',
        output: {
            retracted: false,
            networkStopped: true,
            retractionVariant: 'network',
            approvedPartial,
        },
    };
}
async function completeSafetyTurn(turn, reason) {
    await turn.eventWriter.appendEvents([
        buildCompletedTerminalStatusEvent({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            statusEventId: `local-${reason}-${turn.turnId}-status`,
        }),
    ]);
}
export async function finishCancelledTurn(turn, approvedPartial) {
    await turn.eventWriter.appendEvents([
        buildAbortedTerminalStatusEvent({
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            statusEventId: `local-cancelled-${turn.turnId}-status`,
        }),
    ]);
    return buildSafetyTurnOutput(turn, { retracted: false, networkStopped: false, approvedPartial }, 0);
}
export function buildSafetyTurnOutput(turn, output, eventStart) {
    const { retracted, networkStopped, retractionVariant, approvedPartial } = output;
    return {
        events: turn.eventWriter.events,
        frames: turn.eventWriter.frames,
        eventWriter: turn.eventWriter,
        retracted,
        networkStopped,
        ...((retracted || networkStopped) && retractionVariant ? { retractionVariant } : {}),
        ...(approvedPartial ? { approvedPartial } : {}),
        ...(eventStart > 0 ? { timingEventsStartIndex: eventStart } : {}),
    };
}
//# sourceMappingURL=host-safety-attempt.js.map