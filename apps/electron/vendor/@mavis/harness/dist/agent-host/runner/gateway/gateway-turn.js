import { getRuntimeBuildEnv } from '@mavis/config';
import { readPtcChildTools } from '../../execution/ptc/catalog.js';
import { DEFAULT_OUTPUT_REVISION_INSTRUCTION } from '../../preparation/config/prompt-templates.js';
import { isInputSafetyDecisionFor } from '../input-safety.js';
import { withLlmResponseIdentifierLogging } from '../observability/llm-response-identifiers.js';
import { hasSendToUserTool, SendToUserDisplayProjectionWriter, } from '../output/send-to-user-display-projection.js';
import { chainedResolveMissingTool, deferredToolDirectCallWiring, } from '../policy/deferred-tool-direct-call-policy.js';
import { directPtcChildCallWiring } from '../ptc-direct-call-wiring.js';
import { appendCancelledTurn, combineAbortSignals, isTerminalStatus, missingTurnToolMessage, requireToolContext, toPiRunTurnInput, withTurnEventReporter, } from '../turn-runner-support.js';
import { GatewayOutputEventWriter } from './gateway-output-event-writer.js';
import { buildGatewayRunnerResult, createGatewayRunnerState, onContentRejected, settleGatewayTurn, } from './gateway-settlement.js';
export class GatewayTurnRunner {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async runTurnCore(input, observation) {
        const baseToolContext = requireToolContext(input);
        const observedLlm = withLlmResponseIdentifierLogging(input.llm, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            logger: this.deps.logger,
        });
        const state = createGatewayRunnerState(input);
        const toolContext = withTurnEventReporter(baseToolContext, state);
        if (input.signal?.aborted) {
            await appendCancelledTurn(input, state);
            return buildGatewayRunnerResult(input, state);
        }
        const acceptance = inputAcceptance(input);
        if (acceptance === 'immediate')
            noteInputAccepted(input, state);
        const writer = new GatewayOutputEventWriter(state.visibleText.watch(gateTerminalOnAbort(input)), { ptcEnabled: input.ptcTools !== undefined || readPtcChildTools(input.tools) !== undefined });
        state.activeWriter = writer;
        // Pi 之外产生的侧事件（如用户插话撤回）走同一个 writer，和 Pi 的帧共用一个顺序。
        await input.sideEventRouter?.attach(writer);
        const turnAbort = new AbortController();
        const scope = { input, toolContext, observedLlm, state, writer, turnAbort, observation };
        const result = await this.runPi({ ...scope, acceptance });
        if (state.recallFailure)
            throw state.recallFailure.error;
        // 只有 onRejected 收过尾（writer 已 block）的结果才接管终态；否则 Pi 的终态帧已经照常下发。
        await settleGatewayTurn({ input, state, writer, ...(this.deps.logger ? { logger: this.deps.logger } : {}) }, writer.blocked ? result?.contentReview : undefined);
        input.sideEventRouter?.detach(writer);
        reportDeferredInputAcceptance(input, state);
        return buildGatewayRunnerResult(input, state);
    }
    async runPi(scope) {
        const { input, toolContext, observedLlm, state, writer, turnAbort } = scope;
        const displayWriter = sendToUserDisplayWriter(input, writer);
        const contextUsageAttempt = this.deps.prepareContextUsageAttempt(input, observedLlm, displayWriter);
        const ptcTools = input.ptcTools ?? readPtcChildTools(input.tools);
        const direct = directPtcChildCallWiring(input, ptcTools, toolContext, this.deps.metricsClient);
        const deferred = ptcTools ? undefined : deferredToolDirectCallWiring(input.tools);
        const resolveMissingTool = chainedResolveMissingTool(direct.toolConfig.resolveMissingTool, deferred?.resolveMissingTool);
        const hooks = turnHooks(scope, direct.input.hooks);
        const contentReview = this.contentReviewOptions(scope);
        let result;
        try {
            result = await this.deps.piRunner.runTurn({
                ...toPiRunTurnInput(input),
                ...observeSteering(input, state),
                ...(hooks ? { hooks } : {}),
                ...(contentReview ? { contentReview } : {}),
                ...turnTimingField(input),
                ...state.visibleText.runInput(),
                llm: contextUsageAttempt?.llm ?? observedLlm,
                eventWriter: contextUsageAttempt?.eventWriter ?? displayWriter,
                signal: combineAbortSignals(input.signal, turnAbort.signal),
                captureToolTiming: getRuntimeBuildEnv() !== 'prod',
                eventIdGenerator: state.eventIdGenerator,
                runtimeSeqGenerator: state.runtimeSeqGenerator,
                toolConfig: {
                    tools: input.tools ?? [],
                    ...direct.toolConfig,
                    ...deferred,
                    resolveMissingTool,
                    missingToolMessage: (toolName) => missingTurnToolMessage(toolName, ptcTools),
                    disableBuiltinToolFallback: input.disableBuiltinToolFallback ?? true,
                    context: toolContext,
                },
            });
        }
        catch (runFailure) {
            throw await attemptFailureAfterDrain(writer, runFailure);
        }
        await writer.drain();
        return result;
    }
    /** 只给托管模型（经网关）的 turn 开启网关打回处理；BYOK 直连 provider，不经审核。 */
    contentReviewOptions(scope) {
        const { input } = scope;
        if (input.contentReviewRequired === false)
            return undefined;
        return {
            maxRegenerations: this.deps.maxRegenerations,
            defaultGuidePrompt: input.outputRevisionInstruction ?? DEFAULT_OUTPUT_REVISION_INSTRUCTION,
            onRejected: (rejection) => onContentRejected({ ...scope, rejection }),
        };
    }
}
/** TUI 把输入接受的通知推迟到本轮回答结束后发。 */
function reportDeferredInputAcceptance(input, state) {
    if (input.deferInputReviewResolution !== true || !state.inputAccepted)
        return;
    if (!input.signal?.aborted)
        input.onInputReviewResolved?.(false);
}
/** 本轮交给 Pi 的 hooks：托管模型要等第一条正常回复才算接受用户原话时，在最前面加上观察。 */
function turnHooks(scope, directHooks) {
    const { input, state } = scope;
    return withInputAcceptanceHook(directHooks ?? input.hooks, scope.acceptance === 'first-reply' ? () => noteInputAccepted(input, state) : undefined);
}
/**
 * Pi 失败后先等已排队的事件送完，再决定抛什么：投递也失败且不是同一个错误时一起抛出。
 * 事件投递失败本身就会让 Pi 失败，这时两个是同一个错误，不重复包装。
 */
async function attemptFailureAfterDrain(writer, runFailure) {
    try {
        await writer.drain();
    }
    catch (deliveryFailure) {
        if (deliveryFailure === runFailure)
            return runFailure;
        return new AggregateError([runFailure, deliveryFailure], 'Pi attempt and event delivery failed.');
    }
    return runFailure;
}
function hasMatchingInputDecision(input) {
    return Boolean(input.inputSafetyDigest &&
        isInputSafetyDecisionFor(input.inputSafetyDecision, input.inputSafetyDigest));
}
/**
 * 本轮用户原话什么时候算被接受（会话标题据此生成）：
 * - `immediate`：BYOK 不经网关审核，或带着与本轮输入完全一致的历史放行记录；
 * - `first-reply`：托管模型要等本轮第一次模型调用的回复正常结束，网关的输入审核随这次调用一起做完；
 *   这次调用被打回并结束本轮时（撤回、固答、重发用完）就不算接受；
 * - `undefined`：没有可见输入，或没人关心。
 */
function inputAcceptance(input) {
    if (!input.onInputReviewResolved)
        return undefined;
    if (input.contentReviewRequired === false || hasMatchingInputDecision(input))
        return 'immediate';
    return input.reviewUserInput?.trim() ? 'first-reply' : undefined;
}
function noteInputAccepted(input, state) {
    if (state.inputAccepted)
        return;
    state.inputAccepted = true;
    if (input.deferInputReviewResolution !== true)
        input.onInputReviewResolved?.(false);
}
/**
 * 在 afterLlmCall hook 的最前面观察回复：本轮第一条正常结束的回复（不是 error / aborted）到达时
 * 通知一次。网关打回的回复不会走到 afterLlmCall hook。观察本身不能抛错，否则 Pi 会让本轮失败。
 */
function withInputAcceptanceHook(hooks, onAccepted) {
    if (!onAccepted)
        return hooks;
    let accepted = false;
    const observe = ({ message }) => {
        if (accepted || message.stopReason === 'error' || message.stopReason === 'aborted') {
            return undefined;
        }
        accepted = true;
        try {
            onAccepted();
        }
        catch {
            // 标题是旁路工作，不能改变本轮结果。
        }
        return undefined;
    };
    return { ...hooks, afterLlmCallHook: [observe, ...(hooks?.afterLlmCallHook ?? [])] };
}
/**
 * 记下本轮有没有插进来的消息：Pi 每次轮询拿到的消息都会随下一次模型调用进入本轮。
 * 输出被拦时据此判断能不能整轮撤回（见 `gateway-settlement.ts`）。
 */
function observeSteering(input, state) {
    const poll = input.getSteeringMessages;
    if (!poll)
        return {};
    return {
        getSteeringMessages: async (context) => {
            const messages = await poll(context);
            if (messages.length > 0)
                state.steeringJoined = true;
            return messages;
        },
    };
}
/** 受理时打的准备阶段时间点只交给计时的轮次，用于首字打点。 */
function turnTimingField(input) {
    return input.turnTiming ? { turnTiming: input.turnTiming } : {};
}
/** Bunny 的 send_to_user 在展示侧改写成普通正文；writer 本身不送审，只负责下发。 */
function sendToUserDisplayWriter(input, writer) {
    return hasSendToUserTool(input.tools)
        ? new SendToUserDisplayProjectionWriter(writer, input.replyOrigin)
        : writer;
}
/**
 * 用户中止时压住 Pi 的终态帧：Pi 中止时不发最后一条 assistant 完成帧，由 runner 先把已显示的部分
 * 按原消息 id 落库，再写中止终态（见 `appendCancelledTurn`）。
 */
function gateTerminalOnAbort(input) {
    const suppressTerminal = () => input.signal?.aborted === true;
    return {
        pushRuntime: async (event) => {
            if (isTerminalStatus(event) && suppressTerminal())
                return;
            await input.eventWriter.pushRuntime(event);
        },
        appendEvents: async (events) => {
            const accepted = events.some(isTerminalStatus) && suppressTerminal()
                ? events.filter((event) => !isTerminalStatus(event))
                : events;
            if (accepted.length > 0)
                await input.eventWriter.appendEvents(accepted);
        },
    };
}
//# sourceMappingURL=gateway-turn.js.map