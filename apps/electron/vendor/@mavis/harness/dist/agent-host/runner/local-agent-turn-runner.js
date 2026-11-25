import { PiTurnRunner, } from '@mavis/agent-core/pi-turn-runner';
import { getRuntimeBuildEnv } from '@mavis/config';
import { inputReviewDisposition, isInputSafetyDecisionFor } from './input-safety.js';
import { dialogReviewBlocks, dialogReviewUnavailable, } from '@mavis/shared/local-runtime-safety';
import { createDialogSafetyReview, } from './policy/dialog-safety-review.js';
import { LocalOutputSafetyEventWriter, } from './output/output-safety-event-writer.js';
import { reportInputReviewResolution, reviewInputText, } from './policy/input-review.js';
import { closeSideEventRouter } from '../events/turn-side-event-router.js';
import { callableTurnToolNames, isComputerUseTool, runWithLocalEvalReporter, } from './eval-reporter.js';
import { deriveLocalTurnRuntimeOutcome } from './turn-outcome.js';
import { withLlmResponseIdentifierLogging } from './observability/llm-response-identifiers.js';
import { hasSendToUserTool, SendToUserDisplayProjectionWriter, } from './output/send-to-user-display-projection.js';
import { appendSafetyReplacement } from './output/safety-replacement.js';
import { TurnVisibleTextWatch } from './observability/turn-visible-text.js';
import { DEFAULT_OUTPUT_REVISION_INSTRUCTION } from '../preparation/config/prompt-templates.js';
import { readPtcChildTools } from '../execution/ptc/catalog.js';
import { chainedResolveMissingTool, deferredToolDirectCallWiring, } from './policy/deferred-tool-direct-call-policy.js';
import { directPtcChildCallWiring } from './ptc-direct-call-wiring.js';
import { appendCancelledTurn, appendSyntheticCompleted, combineAbortSignals, isTerminalStatus, missingTurnToolMessage, recallAttempt, requireToolContext, toPiRunTurnInput, withTurnEventReporter, } from './turn-runner-support.js';
import { GatewayTurnRunner } from './gateway/gateway-turn.js';
const OUTPUT_SAFETY_MAX_REGENERATIONS = 3;
/**
 * V2 production runner: direct Pi invocation plus local input/output safety policy.
 * 没给 `reviewContent`，或 `gatewayReviewEnabled` 在本轮开始时返回 `true`，本轮交给
 * `GatewayTurnRunner`，不走本地送审。
 */
export class LocalAgentTurnRunner {
    options;
    piRunner;
    outputSafetyMaxRegenerations;
    dialogSafety;
    gateway;
    constructor(options) {
        this.options = options;
        this.piRunner = options.piRunner ?? new PiTurnRunner(buildLocalPiTurnRunnerOptions(options));
        this.dialogSafety = createDialogSafetyReview({
            ...options,
            reviewContent: options.reviewContent ?? noLocalReview,
        });
        this.outputSafetyMaxRegenerations =
            options.outputSafetyMaxRegenerations ?? OUTPUT_SAFETY_MAX_REGENERATIONS;
        this.gateway =
            options.reviewContent && !options.gatewayReviewEnabled
                ? undefined
                : new GatewayTurnRunner({
                    piRunner: this.piRunner,
                    maxRegenerations: this.outputSafetyMaxRegenerations,
                    ...(options.logger ? { logger: options.logger } : {}),
                    ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
                    prepareContextUsageAttempt: (input, llm, eventWriter) => this.prepareContextUsageAttempt(input, llm, eventWriter),
                });
    }
    async runTurn(input) {
        const isUserTurn = input.reviewUserInput !== undefined &&
            (input.caller === undefined || input.caller === 'chat' || input.caller === 'channel_feishu');
        const observation = { regenerations: 0 };
        try {
            const capture = this.beginComputerUseCapture(input);
            return await runWithLocalEvalReporter(this.options.evalReporterFactory, { ...input, computerUseCapture: capture ? await capture : undefined }, (reportedInput) => this.runTurnCore(reportedInput, observation), this.options.logger);
        }
        finally {
            if (isUserTurn)
                this.recordRegenerations(input, observation.regenerations);
            // A PTC Turn ends with one `ptc turn summary` line; no-op on other Turns.
            input.toolContext?.ptcObserver?.finishTurn();
            await closeSideEventRouter(input.sideEventRouter, input, this.options.logger);
        }
    }
    beginComputerUseCapture(input) {
        // computer_* may be run_code children on a PTC Turn; capture still applies.
        const toolNames = callableTurnToolNames(input.tools);
        if (input.signal?.aborted || !toolNames.some(isComputerUseTool))
            return undefined;
        return this.options.beginComputerUseCapture?.({
            sessionId: input.sessionId,
            turnId: input.turnId,
            model: {
                id: input.llm.model.id,
                provider: input.llm.model.provider,
                api: input.llm.model.api,
            },
            toolNames,
        });
    }
    /** 本轮是否交给网关审核；没有本地送审端口时只能走网关，开关读不出来时按本地送审处理。 */
    reviewsInGateway() {
        if (!this.options.reviewContent)
            return true;
        try {
            return this.options.gatewayReviewEnabled?.() === true;
        }
        catch {
            return false;
        }
    }
    async runTurnCore(input, observation) {
        if (this.gateway && this.reviewsInGateway()) {
            return this.gateway.runTurnCore(input, observation);
        }
        const baseToolContext = requireToolContext(input);
        const observedLlm = withLlmResponseIdentifierLogging(input.llm, {
            sessionId: input.sessionId,
            turnId: input.turnId,
            logger: this.options.logger,
        });
        const state = this.createRunState(input);
        const toolContext = withTurnEventReporter(baseToolContext, state);
        if (input.signal?.aborted) {
            await appendCancelledTurn(input, state);
            return buildRunnerResult(input, state);
        }
        await this.runAttempts({ input, toolContext, observedLlm, state, observation });
        const inputRejected = await waitForInputReview(state.inputReview, input.signal);
        if (input.signal?.aborted)
            return buildRunnerResult(input, state);
        if (input.deferInputReviewResolution === true && shouldReportInputReviewResolution(input)) {
            input.onInputReviewResolved?.(state.inputTitleRejected);
        }
        await this.settleInputReview(input, state, inputRejected);
        return buildRunnerResult(input, state);
    }
    recordRegenerations(input, regenerations) {
        try {
            this.options.metricsClient?.histogram('output_safety_regenerations_per_user_turn', regenerations, {
                provider: String(input.llm.model.provider),
                model: String(input.llm.model.id),
                caller: input.caller ?? 'unknown',
            });
        }
        catch {
            // Metrics must not change or mask the product-path outcome.
        }
    }
    createRunState(input) {
        const state = createMutableRunnerState(input);
        state.inputReview = this.reviewInput(input, (rejected, variant, safetyReviewUnknown, result) => {
            state.inputRejected = rejected;
            state.inputTitleRejected = result ? dialogReviewBlocks(result) : rejected;
            state.retractionVariant = variant;
            state.inputSafetyReviewUnknown ||= safetyReviewUnknown;
            applyInputCorrection(state, result);
            if (rejected) {
                state.retractionSource = 'input-review';
            }
            if (rejected || state.inputCorrectionPending)
                state.activeWriter?.block();
        }, (slow) => {
            state.slowNetworkRead = slow;
        }, () => this.notifySlowReview(input, state));
        return state;
    }
    /** 本轮第一次出现慢送审时通知一次；通知只用于展示，出错也不能影响本轮。 */
    notifySlowReview(input, state) {
        if (state.slowReviewNotified)
            return;
        state.slowReviewNotified = true;
        state.slowReviewActive = true;
        try {
            this.options.onSlowReview?.({ sessionId: input.sessionId, turnId: input.turnId });
        }
        catch {
            // 慢送审提示只是展示用，不能改变本轮结果。
        }
    }
    /** 本轮曾提示过慢送审、后续输出送审恢复正常速度并通过时，通知界面清除提示。 */
    clearSlowReview(input, state) {
        if (!state.slowReviewActive || state.inputRejected || state.inputCorrectionPending)
            return;
        state.slowReviewActive = false;
        try {
            this.options.onSlowReview?.({
                sessionId: input.sessionId,
                turnId: input.turnId,
                cleared: true,
            });
        }
        catch {
            // 慢送审提示只是展示用，不能改变本轮结果。
        }
    }
    async runAttempts(scope) {
        const { input, toolContext, observedLlm, state, observation } = scope;
        let regenerationCount = 0;
        let attemptIndex = 0;
        while (regenerationCount <= this.outputSafetyMaxRegenerations) {
            const safetyAbort = new AbortController();
            const safetyWriter = this.createSafetyWriter(input, state, safetyAbort, attemptIndex);
            state.activeWriter = safetyWriter;
            // Side events raised outside Pi join this attempt's queue so safety
            // buffering cannot deliver them ahead of an older buffered event.
            await input.sideEventRouter?.attach(safetyWriter);
            if (state.inputRejected)
                safetyWriter.block();
            state.finalAttemptEventStart = input.eventWriter.events.length;
            try {
                await this.runPiAttempt({
                    input,
                    toolContext,
                    observedLlm,
                    state,
                    safetyAbort,
                    safetyWriter,
                    regenerationCount,
                    attemptIndex,
                });
            }
            catch (attemptFailure) {
                try {
                    await safetyWriter.drain();
                }
                catch (deliveryFailure) {
                    throw new AggregateError([attemptFailure, deliveryFailure], 'Pi attempt and event delivery failed.');
                }
                throw attemptFailure;
            }
            await safetyWriter.drain();
            await waitForInputReview(state.inputReview, input.signal);
            const decision = await this.settleAttempt({
                input,
                state,
                safetyWriter,
                regenerationCount,
                attemptIndex,
            });
            input.sideEventRouter?.detach(safetyWriter);
            if (decision === 'break')
                return;
            attemptIndex += 1;
            if (decision === 'continue') {
                regenerationCount += 1;
                observation.regenerations += 1;
            }
        }
    }
    createSafetyWriter(input, state, safetyAbort, attemptIndex) {
        return new LocalOutputSafetyEventWriter(state.visibleText.watch(gateTerminalOnInputReview(input, state)), {
            sessionId: input.sessionId,
            turnId: input.turnId,
            ...(input.streamUnreviewedOutput === true && input.contentReviewRequired === false
                ? { reviewRequired: false, checkText: async () => ({ pass: true }) }
                : {
                    checkText: input.contentReviewRequired === false
                        ? async () => ({ pass: true })
                        : this.dialogSafety.review,
                }),
            localErrorMaxRetries: this.dialogSafety.maxRetries,
            onReviewUnavailable: this.dialogSafety.unavailable,
            onBlocked: () => safetyAbort.abort(state.inputRejected ? 'input_safety' : 'output_safety'),
            onSlowReview: () => this.notifySlowReview(input, state),
            onSlowReviewCleared: () => this.clearSlowReview(input, state),
            ...(this.options.outputSafetyRetryDelay
                ? { retryDelay: this.options.outputSafetyRetryDelay }
                : {}),
            ...(this.options.metricsClient ? { metricsClient: this.options.metricsClient } : {}),
            ...(input.contentReviewRequired === true ? { authErrorVariant: 'auth' } : {}),
            ...(input.persistApprovedPartialOnNetworkStop === false
                ? { persistApprovedPartialOnNetworkStop: false }
                : {}),
            ptcEnabled: input.ptcTools !== undefined || readPtcChildTools(input.tools) !== undefined,
            ...this.reviewOfflineWaitOption(input, safetyAbort.signal),
            ...(input.signal ? { signal: input.signal } : {}),
            ...firstChunkTiming(input, attemptIndex),
        });
    }
    reviewOfflineWaitOption(input, safetySignal) {
        const create = this.options.reviewOfflineWait;
        // A host lease (model access, BYOK keys) bounds the model call without an
        // offline wait; its reviews do not wait either, or they would hold a failed
        // Turn open for hours.
        if (!create || input.llm.callLifecycle)
            return {};
        return {
            offlineWait: create({
                sessionId: input.sessionId,
                turnId: input.turnId,
                signal: combineAbortSignals(input.signal, safetySignal),
            }),
        };
    }
    async runPiAttempt(scope) {
        const { input, toolContext, observedLlm, state, safetyAbort, safetyWriter, regenerationCount } = scope;
        const systemPrompt = systemPromptForAttempt(input.systemPrompt, regenerationCount, state.pendingRevisionInstruction ?? input.outputRevisionInstruction, state.pendingRevisionInstruction !== undefined);
        state.pendingRevisionInstruction = undefined;
        observeLlmAttempt(input, scope.attemptIndex, systemPrompt);
        // send_to_user becomes plain assistant text before output review, so the rewritten
        // text is still reviewed. Side events on state.activeWriter never carry it.
        const displayWriter = hasSendToUserTool(input.tools)
            ? new SendToUserDisplayProjectionWriter(safetyWriter, input.replyOrigin)
            : safetyWriter;
        const contextUsageAttempt = this.prepareContextUsageAttempt(input, observedLlm, displayWriter);
        const ptcTools = input.ptcTools ?? readPtcChildTools(input.tools);
        const direct = directPtcChildCallWiring(input, ptcTools, toolContext, this.options.metricsClient);
        const deferred = ptcTools ? undefined : deferredToolDirectCallWiring(input.tools);
        const resolveMissingTool = chainedResolveMissingTool(direct.toolConfig.resolveMissingTool, deferred?.resolveMissingTool);
        await this.piRunner.runTurn({
            ...toPiRunTurnInput(input),
            ...direct.input,
            ...firstAttemptOnly(scope.attemptIndex, input.turnTiming ? { turnTiming: input.turnTiming } : {}),
            ...state.visibleText.runInput(),
            llm: contextUsageAttempt?.llm ?? observedLlm,
            systemPrompt,
            eventWriter: contextUsageAttempt?.eventWriter ?? displayWriter,
            signal: combineAbortSignals(input.signal, safetyAbort.signal),
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
    prepareContextUsageAttempt(input, llm, eventWriter) {
        const capability = this.options.contextUsage;
        if (!capability ||
            input.contextUsagePromptRanges === undefined ||
            input.toolContext?.channelContext) {
            return undefined;
        }
        try {
            if (!capability.isEnabled())
                return undefined;
            return capability.prepareAttempt({
                sessionId: input.sessionId,
                turnId: input.turnId,
                promptRanges: input.contextUsagePromptRanges,
                requiresProviderAnchor: input.contextUsageRequiresProviderAnchor === true,
                llm,
                eventWriter,
            });
        }
        catch {
            // Context Usage is diagnostic decoration and cannot change the owning Turn.
            return undefined;
        }
    }
    async settleAttempt(scope) {
        const { input, state, safetyWriter, regenerationCount, attemptIndex } = scope;
        if (input.signal?.aborted) {
            // Cancellation still settles canonical history from the already released prefix.
            // A rejected or superseded attempt must not be resurrected by that settlement.
            if (!safetyWriter.blocked) {
                state.approvedPartial = safetyWriter.getApprovedPartial();
            }
            await appendCancelledTurn(input, state);
            return 'break';
        }
        if (await this.settlePtcSafetyStop(input, state, safetyWriter))
            return 'break';
        if (state.inputRejected)
            return 'break';
        const inputCorrection = await settleInputCorrection(input, state, safetyWriter, attemptIndex + 1);
        if (inputCorrection)
            return inputCorrection;
        if (safetyWriter.networkStopped) {
            await settleNetworkStop(input, state, safetyWriter, this.options.logger);
            return 'break';
        }
        if (!safetyWriter.blocked) {
            state.approvedPartial = safetyWriter.getApprovedPartial();
            return 'break';
        }
        if (safetyWriter.immediateBlock || regenerationCount >= this.outputSafetyMaxRegenerations) {
            await settleOutputRetraction(input, state);
            return 'break';
        }
        state.pendingRevisionInstruction = safetyWriter.guidePrompt;
        await recallAttempt(input, safetyWriter, attemptIndex + 1);
        return 'continue';
    }
    async settlePtcSafetyStop(input, state, writer) {
        if (!writer.hasPtcChildCalls() || !requiresSafetyStop(state, writer))
            return false;
        const inputSafetyStopped = state.inputRejected || state.inputCorrectionPending;
        state.ptcSafetyStopped = true;
        state.inputCorrectionPending = false;
        if (writer.networkStopped)
            await settleNetworkStop(input, state, writer, this.options.logger);
        else if (!state.inputRejected) {
            await settleOutputRetraction(input, state);
            if (inputSafetyStopped)
                state.retractionSource = 'input-review';
        }
        return true;
    }
    async settleInputReview(input, state, inputRejected) {
        if (!inputRejected || state.retracted)
            return;
        state.retracted = true;
        state.retractionVariant ??= 'content';
        await appendSyntheticCompleted(input, `local-input-retracted-${input.turnId}-status`);
    }
    async reviewInput(input, ...observers) {
        if (input.signal?.aborted)
            return false;
        if (input.contentReviewRequired === false) {
            reportInputReviewResolution(input, false);
            return false;
        }
        if (input.inputSafetyDigest &&
            isInputSafetyDecisionFor(input.inputSafetyDecision, input.inputSafetyDigest)) {
            observers[0](false, undefined, input.inputSafetyDecision.outcome === 'degraded');
            reportInputReviewResolution(input, false);
            return false;
        }
        const reviewText = input.reviewUserInput;
        if (!reviewText?.trim())
            return false;
        const [observe, observeNetworkFailure, observeSlowReview] = observers;
        return reviewInputText(
        // The shared module reports the resolution with `reviewBlocks`; a dialog input review
        // fails closed, so this runner reports it itself once the verdict is in.
        { ...input, deferInputReviewResolution: true }, reviewText, {
            // The dialog review port: policy timeout, stage gate and safety metrics.
            reviewContent: this.dialogSafety.review,
            ...this.reviewOfflineWaitOption(input),
        }, (rejected, variant, safetyReviewUnknown, result) => {
            // A review that gave no verdict is counted as unavailable and blocks.
            if (result)
                countInputUnavailable(this.dialogSafety, result);
            else
                this.dialogSafety.unavailable(300);
            // A review that threw has no errorKind to reclassify: the shared module already
            // called it a transport failure, and reclassifying it from `undefined` would
            // turn that network stop into a content retraction. Only a returned verdict is
            // reclassified, because the shared module reads an `api_error` as content while
            // a dialog input review retracts on it like a network failure.
            const dialogVariant = result
                ? inputReviewVariant(rejected, result.errorKind, input.contentReviewRequired === true)
                : variant;
            observe(rejected, dialogVariant ?? variant, safetyReviewUnknown, result);
            reportInputReviewResolution(input, result ? dialogReviewBlocks(result) : true);
        }, observeNetworkFailure, observeSlowReview);
    }
}
/**
 * A turn is measured from its acceptance once: a regenerated or corrected
 * attempt carries neither the preparation marks nor the first-chunk timing.
 */
function firstAttemptOnly(attemptIndex, fields) {
    return attemptIndex === 0 ? fields : {};
}
/** The caller label of `output_safety_first_chunk_ms`, on the turn's first attempt only. */
function firstChunkTiming(input, attemptIndex) {
    return firstAttemptOnly(attemptIndex, { firstChunkCaller: input.caller ?? 'unknown' });
}
function requiresSafetyStop(state, writer) {
    return (state.inputRejected || state.inputCorrectionPending || writer.blocked || writer.networkStopped);
}
/** 输入审核不重试：没有判定结果就在这里计一次最终不可用。 */
function countInputUnavailable(dialogSafety, result) {
    if (dialogReviewUnavailable(result))
        dialogSafety.unavailable(300);
}
function shouldReportInputReviewResolution(input) {
    if (!input.onInputReviewResolved)
        return false;
    if (input.contentReviewRequired === false)
        return true;
    if (input.inputSafetyDigest &&
        isInputSafetyDecisionFor(input.inputSafetyDecision, input.inputSafetyDigest)) {
        return true;
    }
    return Boolean(input.reviewUserInput?.trim());
}
/** 网关模式没有本地送审端口，`runTurnCore` 在送审之前就转去网关路径；走到这里说明分流出了错。 */
const noLocalReview = async () => {
    throw new Error('LocalAgentTurnRunner has no local content review port in gateway mode.');
};
/** 只把 Pi runner 需要的进程级能力交给具体实现。 */
function buildLocalPiTurnRunnerOptions(options) {
    return {
        registryMetrics: true,
        ...(options.messageIdAllocator ? { messageIdAllocator: options.messageIdAllocator } : {}),
        ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.onLLMRequestFailure ? { onLLMRequestFailure: options.onLLMRequestFailure } : {}),
        ...(options.observeLLMRequest ? { observeLLMRequest: options.observeLLMRequest } : {}),
        ...(options.llmCaptureFactory ? { llmCaptureFactory: options.llmCaptureFactory } : {}),
    };
}
function createMutableRunnerState(input) {
    let eventIdentitySequence = 0;
    let runtimeSequence = 0;
    return {
        inputRejected: false,
        inputTitleRejected: false,
        inputCorrectionPending: false,
        inputReview: Promise.resolve(false),
        retracted: false,
        networkStopped: false,
        slowNetworkRead: false,
        slowReviewNotified: false,
        slowReviewActive: false,
        inputSafetyReviewUnknown: false,
        ptcSafetyStopped: false,
        finalAttemptEventStart: input.eventWriter.events.length,
        visibleText: new TurnVisibleTextWatch(input.turnTiming !== undefined),
        eventIdGenerator: input.eventIdGenerator ??
            ((kind) => `evt_${input.turnId}_${kind}_${++eventIdentitySequence}`),
        runtimeSeqGenerator: input.runtimeSeqGenerator ?? (() => ++runtimeSequence),
    };
}
function applyInputCorrection(state, result) {
    const disposition = result ? inputReviewDisposition(result) : undefined;
    if (disposition?.kind === 'replace') {
        state.replacementText = disposition.replacement;
        state.inputCorrectionPending = state.activeWriter !== undefined;
    }
    else if (disposition?.kind === 'proceed' && disposition.guidance) {
        state.pendingRevisionInstruction = disposition.guidance;
        state.inputCorrectionPending = state.activeWriter !== undefined;
    }
}
function gateTerminalOnInputReview(input, state) {
    const suppressTerminal = async () => (await waitForInputReview(state.inputReview, input.signal)) ||
        state.inputCorrectionPending ||
        input.signal?.aborted === true;
    return {
        pushRuntime: async (event) => {
            if (isTerminalStatus(event) && (await suppressTerminal()))
                return;
            await input.eventWriter.pushRuntime(event);
        },
        appendEvents: async (events) => {
            if (!events.some(isTerminalStatus)) {
                await input.eventWriter.appendEvents(events);
                return;
            }
            const accepted = (await suppressTerminal())
                ? events.filter((event) => !isTerminalStatus(event))
                : events;
            if (accepted.length > 0)
                await input.eventWriter.appendEvents(accepted);
        },
    };
}
async function waitForInputReview(review, signal) {
    if (!signal)
        return review;
    if (signal.aborted)
        return false;
    let onAbort = () => undefined;
    const aborted = new Promise((resolve) => {
        onAbort = () => resolve(false);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        return await Promise.race([review, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
async function settleInputCorrection(input, state, safetyWriter, attempt) {
    if (!state.inputCorrectionPending)
        return undefined;
    // An input guide cannot override a final output Block.
    if (!state.replacementText && safetyWriter.immediateBlock) {
        return undefined;
    }
    await recallAttempt(input, safetyWriter, attempt);
    state.inputCorrectionPending = false;
    if (input.signal?.aborted) {
        await appendCancelledTurn(input, state);
        return 'break';
    }
    if (!state.replacementText)
        return 'retry-input';
    if (!(await appendSafetyReplacement(input, state.replacementText, state))) {
        await appendCancelledTurn(input, state);
    }
    return 'break';
}
async function settleNetworkStop(input, state, safetyWriter, logger) {
    if (safetyWriter.terminalFailed)
        return;
    logger?.warn?.({
        sessionId: input.sessionId,
        turnId: input.turnId,
        reviewOutcome: safetyWriter.reviewStopVariant === 'auth' ? 'auth_error' : 'unavailable',
        outputSuppressed: true,
        terminalStatus: 'completed',
    }, '[content-safety] output review stopped turn');
    state.networkStopped = true;
    state.retractionVariant = safetyWriter.reviewStopVariant;
    state.slowNetworkRead = safetyWriter.slowNetworkRead;
    state.approvedPartial = safetyWriter.getApprovedPartial();
    await appendSyntheticCompleted(input, `local-output-network-stopped-${input.turnId}-status`);
}
async function settleOutputRetraction(input, state) {
    state.retracted = true;
    state.retractionVariant = 'content';
    state.retractionSource = 'output-review';
    await appendSyntheticCompleted(input, `local-output-retracted-${input.turnId}-status`);
}
function systemPromptForAttempt(systemPrompt, regenerationCount, outputRevisionInstruction = DEFAULT_OUTPUT_REVISION_INSTRUCTION, hasInputInstruction = false) {
    return regenerationCount > 0 || hasInputInstruction
        ? `${systemPrompt}\n\n${outputRevisionInstruction}`
        : systemPrompt;
}
function observeLlmAttempt(input, attemptIndex, systemPrompt) {
    try {
        input.onLlmAttempt?.({ attemptIndex, systemPrompt });
    }
    catch {
        // Debug observers are best effort and cannot change the owning Turn.
    }
}
function inputReviewVariant(rejected, errorKind, authVariantEnabled) {
    if (!rejected)
        return undefined;
    if (errorKind === 'auth_error')
        return authVariantEnabled ? 'auth' : 'network';
    return errorKind === 'local_error' || errorKind === 'api_error' ? 'network' : 'content';
}
function buildRunnerResult(input, state) {
    const events = input.eventWriter.events;
    const outcome = deriveLocalTurnRuntimeOutcome(events);
    const reconcile = deriveReconcile(state, outcome.status);
    const hasRetractionVariant = (state.retracted || state.networkStopped) && state.retractionVariant;
    return {
        events,
        retracted: state.retracted,
        networkStopped: state.networkStopped,
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
    if (state.ptcSafetyStopped)
        return { kind: 'safety-reconcile', approvedContent: '' };
    if (state.retracted) {
        const variant = state.retractionVariant ?? 'content';
        return {
            kind: 'output-recall',
            source: state.retractionSource ?? 'output-review',
            variant,
            ...(variant === 'network' && state.slowNetworkRead ? { slowNetworkRead: true } : {}),
        };
    }
    if (state.networkStopped) {
        return {
            kind: 'network-reconcile',
            approvedContent: state.approvedPartial?.content,
            ...(state.slowNetworkRead ? { slowNetworkRead: true } : {}),
        };
    }
    if (status === 'aborted') {
        return { kind: 'abort-reconcile', approvedContent: state.approvedPartial?.content };
    }
    return undefined;
}
//# sourceMappingURL=local-agent-turn-runner.js.map