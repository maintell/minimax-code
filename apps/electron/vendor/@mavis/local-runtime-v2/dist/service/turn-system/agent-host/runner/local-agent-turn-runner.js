import { PiTurnRunner, } from '@mavis/agent-core/pi-turn-runner';
import { buildCompletedTerminalStatusEvent, buildAbortedTerminalStatusEvent, } from '@mavis/agent-core/event-bridge';
import { getRuntimeBuildEnv } from '@mavis/config';
import { RespDataType } from '@mavis/agent-core/protocol/agent-message';
import { RUNTIME_EVENT_SCHEMA, RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import { isInputSafetyDecisionFor, reviewBlocks, reviewBlocksInput, } from '../../../content-safety/index.js';
import { LocalOutputSafetyEventWriter, SAFETY_REVIEW_SLOW_READ_MS, } from './output-safety-event-writer.js';
import { runWithLocalEvalReporter } from './eval-reporter.js';
import { deriveLocalTurnRuntimeOutcome } from './turn-outcome.js';
import { appendSafetyReplacement } from './safety-replacement.js';
import { DEFAULT_OUTPUT_REVISION_INSTRUCTION } from '../preparation/config/prompt-templates.js';
import { readPtcChildTools } from '../execution/ptc/catalog.js';
import { prepareDirectCallArguments, withDirectCallArguments, } from './ptc/direct-call-arguments.js';
import { createDirectCallReminder } from './ptc/direct-call-reminder.js';
import { callableTurnToolNames } from './computer-use-capture/reporter.js';
const OUTPUT_SAFETY_MAX_REGENERATIONS = 3;
/** V2 production runner: direct Pi invocation plus local input/output safety policy. */
export class LocalAgentTurnRunner {
    options;
    piRunner;
    outputSafetyMaxRegenerations;
    constructor(options) {
        this.options = options;
        this.piRunner = options.piRunner ?? new PiTurnRunner(buildLocalPiTurnRunnerOptions(options));
        this.outputSafetyMaxRegenerations =
            options.outputSafetyMaxRegenerations ?? OUTPUT_SAFETY_MAX_REGENERATIONS;
    }
    async runTurn(input) {
        const isUserTurn = input.reviewUserInput !== undefined &&
            (input.caller === undefined || input.caller === 'chat' || input.caller === 'channel_feishu');
        const observation = { regenerations: 0 };
        try {
            const capture = this.resolveComputerUseCapture(input);
            return await runWithLocalEvalReporter(this.options.evalReporterFactory, { ...input, computerUseCapture: capture ? await capture : undefined }, (reportedInput) => this.runTurnCore(reportedInput, observation), this.options.logger);
        }
        finally {
            if (isUserTurn)
                this.recordRegenerations(input, observation.regenerations);
            // A PTC Turn ends with one `ptc turn summary` line; no-op on other Turns.
            input.toolContext?.ptcObserver?.finishTurn();
        }
    }
    resolveComputerUseCapture(input) {
        // computer_* may be run_code children on a PTC Turn; capture still applies.
        const toolNames = callableTurnToolNames(input.tools);
        if (input.signal?.aborted || !toolNames.some((name) => name.startsWith('computer_')))
            return undefined;
        return this.options.resolveComputerUseCapture?.({
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
    async runTurnCore(input, observation) {
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
            state.inputTitleRejected = result ? reviewBlocks(result) : rejected;
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
        try {
            this.options.onSlowReview?.({ sessionId: input.sessionId, turnId: input.turnId });
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
            const safetyWriter = this.createSafetyWriter(input, state, safetyAbort);
            state.activeWriter = safetyWriter;
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
            if (decision === 'break')
                return;
            attemptIndex += 1;
            if (decision === 'continue') {
                regenerationCount += 1;
                observation.regenerations += 1;
            }
        }
    }
    createSafetyWriter(input, state, safetyAbort) {
        return new LocalOutputSafetyEventWriter(gateTerminalOnInputReview(input, state), {
            sessionId: input.sessionId,
            turnId: input.turnId,
            ...(input.streamUnreviewedOutput === true && input.contentReviewRequired === false
                ? { reviewRequired: false, checkText: async () => ({ pass: true }) }
                : {
                    checkText: input.contentReviewRequired === false
                        ? async () => ({ pass: true })
                        : this.options.reviewContent,
                }),
            onBlocked: () => safetyAbort.abort(state.inputRejected ? 'input_safety' : 'output_safety'),
            onSlowReview: () => this.notifySlowReview(input, state),
            ...(this.options.outputSafetyRetryDelay
                ? { retryDelay: this.options.outputSafetyRetryDelay }
                : {}),
            ...(this.options.metricsClient ? { metricsClient: this.options.metricsClient } : {}),
            ...(input.contentReviewRequired === true ? { authErrorVariant: 'auth' } : {}),
            ...(input.persistApprovedPartialOnNetworkStop === false
                ? { persistApprovedPartialOnNetworkStop: false }
                : {}),
            ptcEnabled: input.ptcTools !== undefined || readPtcChildTools(input.tools) !== undefined,
        });
    }
    async runPiAttempt(scope) {
        const { input, toolContext, observedLlm, state, safetyAbort, safetyWriter, regenerationCount } = scope;
        const systemPrompt = systemPromptForAttempt(input.systemPrompt, regenerationCount, state.pendingRevisionInstruction ?? input.outputRevisionInstruction, state.pendingRevisionInstruction !== undefined);
        state.pendingRevisionInstruction = undefined;
        observeLlmAttempt(input, scope.attemptIndex, systemPrompt);
        const contextUsageAttempt = this.prepareContextUsageAttempt(input, observedLlm, safetyWriter);
        const ptcTools = input.ptcTools ?? readPtcChildTools(input.tools);
        const direct = directPtcChildCallWiring(input, ptcTools, toolContext);
        await this.piRunner.runTurn({
            ...toPiRunTurnInput(input),
            ...direct.input,
            llm: contextUsageAttempt?.llm ?? observedLlm,
            systemPrompt,
            eventWriter: contextUsageAttempt?.eventWriter ?? safetyWriter,
            signal: combineAbortSignals(input.signal, safetyAbort.signal),
            captureToolTiming: getRuntimeBuildEnv() !== 'prod',
            eventIdGenerator: state.eventIdGenerator,
            runtimeSeqGenerator: state.runtimeSeqGenerator,
            toolConfig: {
                tools: input.tools ?? [],
                ...direct.toolConfig,
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
    async reviewInput(input, observe, 
    // 只在输入审核失败、走网络撤回时调用：告诉调用方这次审核是否等了 15 秒以上。
    observeNetworkFailure, 
    // 审核返回或抛错时等了 15 秒以上就调用，不管成功失败。
    observeSlowReview) {
        if (input.signal?.aborted)
            return false;
        if (input.contentReviewRequired === false) {
            reportInputReviewResolution(input, false);
            return false;
        }
        if (input.inputSafetyDigest &&
            isInputSafetyDecisionFor(input.inputSafetyDecision, input.inputSafetyDigest)) {
            observe(false, undefined, input.inputSafetyDecision.outcome === 'degraded');
            reportInputReviewResolution(input, false);
            return false;
        }
        if (!input.reviewUserInput?.trim())
            return false;
        const startMs = Date.now();
        try {
            const result = normalizeInputReviewResult(await this.options.reviewContent(input.reviewUserInput, 300));
            if (input.signal?.aborted)
                return false;
            const slow = observeReviewElapsed(startMs, observeSlowReview);
            const rejected = reviewBlocksInput(result);
            const variant = inputReviewVariant(rejected, result.errorKind, input.contentReviewRequired === true);
            if (variant === 'network')
                observeNetworkFailure(slow);
            observe(rejected, variant, result.errorKind === 'api_error', result);
            reportInputReviewResolution(input, reviewBlocks(result));
            return rejected;
        }
        catch {
            if (input.signal?.aborted)
                return false;
            observeNetworkFailure(observeReviewElapsed(startMs, observeSlowReview));
            observe(true, 'network', false);
            reportInputReviewResolution(input, true);
            return true;
        }
    }
}
function missingTurnToolMessage(toolName, childTools) {
    if (!childTools && toolName === 'run_code')
        return 'run_code is disabled for this turn. Use the current native tool catalog.';
    return undefined;
}
/**
 * PTC-Turn wiring for direct calls of run_code children: the resolver, and the reminder
 * hook placed after every other after-tool hook so it ends the final result. Empty when
 * the Turn has no PTC.
 */
function directPtcChildCallWiring(input, ptcTools, context) {
    if (!ptcTools)
        return { input: {}, toolConfig: {} };
    const reminder = createDirectCallReminder((fields) => {
        writePtcDirectCallEvent(context, 'ptc hidden tool reminder', fields);
        context.ptcObserver?.directCallSettled(fields.tool, fields.tool_call_id, fields.appended);
    });
    return {
        input: {
            hooks: {
                ...input.hooks,
                afterToolCallHook: [...(input.hooks?.afterToolCallHook ?? []), reminder.afterToolCall],
            },
        },
        toolConfig: {
            ptcTools,
            resolveMissingTool: (toolCall) => resolveDirectPtcChildTool(toolCall, ptcTools, context, reminder),
        },
    };
}
/**
 * A run_code child the model called directly although the top-level catalog omits it runs
 * as that native tool, as it would with PTC off, after the argument repair in
 * `ptc/direct-call-arguments.ts`; the last such call of a reply gets the reminder of
 * `ptc/direct-call-reminder.ts`. The events name the tool, the call, the repair kinds and
 * whether the reminder was appended, never argument values or content.
 */
function resolveDirectPtcChildTool(toolCall, childTools, context, reminder) {
    const tool = childTools.find((candidate) => candidate.def.name === toolCall.name);
    if (!tool)
        return undefined;
    const call = { tool: toolCall.name, tool_call_id: toolCall.id };
    writePtcDirectCallEvent(context, 'ptc hidden tool called directly', call);
    let prepared;
    try {
        prepared = prepareDirectCallArguments(tool, toolCall.arguments);
    }
    catch {
        // The tool's own preparation threw; Pi reports that error when it prepares the call.
        prepared = { fixes: [], valid: false };
    }
    writePtcDirectCallEvent(context, 'ptc hidden tool arguments prepared', {
        ...call,
        fixes: [...prepared.fixes],
        valid: prepared.valid,
    });
    // Before noteResolved: an invalid call is settled (and logged) inside it.
    context.ptcObserver?.directCallResolved(toolCall.id, prepared.valid);
    reminder.noteResolved(toolCall, prepared.valid);
    return withDirectCallArguments(tool);
}
function writePtcDirectCallEvent(context, event, fields) {
    try {
        context.ptcLogger?.info?.({ session_id: context.sessionId, turn_id: context.turnId, ...fields }, event);
    }
    catch {
        // Diagnostics must not change the tool call.
    }
}
function requiresSafetyStop(state, writer) {
    return (state.inputRejected || state.inputCorrectionPending || writer.blocked || writer.networkStopped);
}
function isSlowReview(startMs) {
    return Date.now() - startMs >= SAFETY_REVIEW_SLOW_READ_MS;
}
/** 审核返回（或抛错）时看耗时：等了 15 秒以上先通知慢送审，再把是否慢交给调用方。 */
function observeReviewElapsed(startMs, observeSlowReview) {
    const slow = isSlowReview(startMs);
    if (slow)
        observeSlowReview();
    return slow;
}
function reportInputReviewResolution(input, rejected) {
    if (input.deferInputReviewResolution !== true) {
        input.onInputReviewResolved?.(rejected);
    }
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
/** 只把 Pi runner 需要的进程级能力交给具体实现。 */
function buildLocalPiTurnRunnerOptions(options) {
    return {
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
        inputSafetyReviewUnknown: false,
        ptcSafetyStopped: false,
        finalAttemptEventStart: input.eventWriter.events.length,
        eventIdGenerator: input.eventIdGenerator ??
            ((kind) => `evt_${input.turnId}_${kind}_${++eventIdentitySequence}`),
        runtimeSeqGenerator: input.runtimeSeqGenerator ?? (() => ++runtimeSequence),
    };
}
function normalizeInputReviewResult(result) {
    // Input guides without text pass without interrupting the active attempt.
    return result.action === 'guide' && !result.guide_prompt?.trim()
        ? { pass: true, action: 'allow' }
        : result;
}
function applyInputCorrection(state, result) {
    if (result?.action === 'replace' && result.suggestion?.trim()) {
        state.replacementText = result.suggestion;
        state.inputCorrectionPending = state.activeWriter !== undefined;
    }
    else if (result?.action === 'guide') {
        state.pendingRevisionInstruction = result.guide_prompt?.trim();
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
function isTerminalStatus(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS)
        return false;
    const status = event.payload?.status;
    return (status === RuntimeEventStatus.COMPLETED ||
        status === RuntimeEventStatus.ABORTED ||
        status === RuntimeEventStatus.FAILED);
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
function withTurnEventReporter(context, state) {
    return {
        ...context,
        reporter: {
            nextEventId: state.eventIdGenerator,
            nextRuntimeSeq: state.runtimeSeqGenerator,
            appendEvents: async (events) => {
                // Native side-events must share the attempt writer with Pi so safety buffering
                // cannot deliver a newer runtime sequence before an older buffered event.
                const writer = state.activeWriter;
                if (!writer)
                    throw new Error('Turn event reporter requires an active safety writer.');
                await writer.appendEvents(events);
            },
        },
    };
}
async function appendCancelledTurn(input, state) {
    if (deriveLocalTurnRuntimeOutcome(input.eventWriter.events).status === 'aborted')
        return;
    const partial = state.approvedPartial;
    if (partial?.msgId && partial.content.trim()) {
        // Pi suppresses the final assistant frame on abort. Persist the released text
        // under its streaming identity before the terminal closes Display delivery.
        await input.eventWriter.appendEvents([
            {
                schema: RUNTIME_EVENT_SCHEMA,
                event_id: state.eventIdGenerator('aborted-partial'),
                runtime_seq: state.runtimeSeqGenerator(),
                session_id: input.sessionId,
                turn_id: input.turnId,
                type: RuntimeEventType.STREAM_RESP,
                payload: {
                    stream_resp: JSON.stringify({
                        type: RespDataType.AgentMessage,
                        agent_message: {
                            msg_id: partial.msgId,
                            role: 'assistant',
                            msg_content: partial.content,
                            finish_reason: 'aborted',
                        },
                    }),
                },
            },
        ]);
    }
    await input.eventWriter.appendEvents([
        buildAbortedTerminalStatusEvent({
            sessionId: input.sessionId,
            turnId: input.turnId,
            statusEventId: state.eventIdGenerator('safety-review-aborted'),
        }),
    ]);
}
async function recallAttempt(input, safetyWriter, attempt) {
    if (!input.onOutputRecall) {
        throw new Error('Output recall Display retraction is unavailable.');
    }
    if (!input.recallOutputAttemptHistory) {
        throw new Error('Output recall canonical history retraction is unavailable.');
    }
    await input.onOutputRecall({ attempt, messageIds: safetyWriter.getAttemptMessageIds() });
    await input.recallOutputAttemptHistory(attempt);
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
async function appendSyntheticCompleted(input, statusEventId) {
    await input.eventWriter.appendEvents([
        buildCompletedTerminalStatusEvent({
            sessionId: input.sessionId,
            turnId: input.turnId,
            statusEventId,
        }),
    ]);
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
    return errorKind === 'local_error' ? 'network' : 'content';
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
function requireToolContext(input) {
    if (!input.toolContext) {
        throw new Error('LocalAgentTurnRunner requires a v2 LocalRuntimeTurnToolContext.');
    }
    return input.toolContext;
}
function toPiRunTurnInput(input) {
    return {
        ...toPiCoreInput(input),
        ...toPiControlInput(input),
    };
}
function toPiCoreInput(input) {
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        workspaceDir: input.workspaceDir,
        systemPrompt: input.systemPrompt,
        userMessage: input.userMessage,
        ...(input.beforeUserMessages ? { beforeUserMessages: input.beforeUserMessages } : {}),
        ...(input.startMode ? { startMode: input.startMode } : {}),
        llm: input.llm,
        ...(input.history ? { history: input.history } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.hooks ? { hooks: input.hooks } : {}),
        ...(input.llmRetry ? { llmRetry: input.llmRetry } : {}),
        ...(input.captureToolTiming !== undefined
            ? { captureToolTiming: input.captureToolTiming }
            : {}),
        ...(input.includeDetailedUsage === true ? { includeDetailedUsage: true } : {}),
        ...(input.caller ? { caller: input.caller } : {}),
    };
}
function toPiControlInput(input) {
    return {
        ...(input.eventIdGenerator ? { eventIdGenerator: input.eventIdGenerator } : {}),
        ...(input.runtimeSeqGenerator ? { runtimeSeqGenerator: input.runtimeSeqGenerator } : {}),
        ...(input.getSteeringMessages ? { getSteeringMessages: input.getSteeringMessages } : {}),
        ...(input.shouldStopAfterSteering
            ? { shouldStopAfterSteering: input.shouldStopAfterSteering }
            : {}),
        ...(input.shouldStopAfterTurn ? { shouldStopAfterTurn: input.shouldStopAfterTurn } : {}),
        ...(input.isWorkClosed ? { isWorkClosed: input.isWorkClosed } : {}),
        ...(input.tryBeginClose ? { tryBeginClose: input.tryBeginClose } : {}),
        ...(input.unexpectedToolCallFallback
            ? { unexpectedToolCallFallback: input.unexpectedToolCallFallback }
            : {}),
    };
}
function combineAbortSignals(...signals) {
    const controller = new AbortController();
    signals.forEach((signal) => {
        if (!signal || controller.signal.aborted)
            return;
        if (signal.aborted) {
            controller.abort(signal.reason);
            return;
        }
        signal.addEventListener('abort', () => {
            if (!controller.signal.aborted)
                controller.abort(signal.reason);
        }, { once: true });
    });
    return controller.signal;
}
function withLlmResponseIdentifierLogging(llm, context) {
    const responseObserver = llm.responseObserver;
    return {
        ...llm,
        responseObserver: async (response, model) => {
            const requestId = pickResponseIdentifier(response.headers, [
                'request-id',
                'x-request-id',
                'x-mm-request-id',
            ]);
            const traceId = pickResponseIdentifier(response.headers, [
                'x-trace-id',
                'trace-id',
                'uber-trace-id',
            ]);
            if (requestId || traceId) {
                context.logger?.info?.({
                    session_id: context.sessionId,
                    turn_id: context.turnId,
                    provider: model.provider,
                    model: model.id,
                    response_status: response.status,
                    ...(requestId ? { downstream_request_id: requestId } : {}),
                    ...(traceId ? { downstream_trace_id: traceId } : {}),
                }, 'llm_response_identifiers');
            }
            await responseObserver?.(response, model);
        },
    };
}
function pickResponseIdentifier(headers, names) {
    return names.map((name) => headers[name]).find((value) => value?.trim());
}
//# sourceMappingURL=local-agent-turn-runner.js.map