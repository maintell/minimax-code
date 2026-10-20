import { PiTurnRunner, } from '@mavis/agent-core/pi-turn-runner';
import { buildCompletedTerminalStatusEvent, buildAbortedTerminalStatusEvent, } from '@mavis/agent-core/event-bridge';
import { getRuntimeBuildEnv } from '@mavis/config';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import { isInputSafetyDecisionFor, reviewBlocks, reviewBlocksInput, } from '../../../content-safety/index.js';
import { LocalOutputSafetyEventWriter } from './output-safety-event-writer.js';
import { runWithLocalEvalReporter } from './eval-reporter.js';
import { deriveLocalTurnRuntimeOutcome } from './turn-outcome.js';
import { appendSafetyReplacement } from './safety-replacement.js';
import { DEFAULT_OUTPUT_REVISION_INSTRUCTION } from '../preparation/config/prompt-templates.js';
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
            return await runWithLocalEvalReporter(this.options.evalReporterFactory, input, (reportedInput) => this.runTurnCore(reportedInput, observation), this.options.logger);
        }
        finally {
            if (isUserTurn)
                this.recordRegenerations(input, observation.regenerations);
        }
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
        });
        return state;
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
            ...(this.options.outputSafetyRetryDelay
                ? { retryDelay: this.options.outputSafetyRetryDelay }
                : {}),
            ...(this.options.metricsClient ? { metricsClient: this.options.metricsClient } : {}),
            ...(input.contentReviewRequired === true ? { authErrorVariant: 'auth' } : {}),
            ...(input.persistApprovedPartialOnNetworkStop === false
                ? { persistApprovedPartialOnNetworkStop: false }
                : {}),
        });
    }
    async runPiAttempt(scope) {
        const { input, toolContext, observedLlm, state, safetyAbort, safetyWriter, regenerationCount } = scope;
        const systemPrompt = systemPromptForAttempt(input.systemPrompt, regenerationCount, state.pendingRevisionInstruction ?? input.outputRevisionInstruction, state.pendingRevisionInstruction !== undefined);
        state.pendingRevisionInstruction = undefined;
        observeLlmAttempt(input, scope.attemptIndex, systemPrompt);
        const contextUsageAttempt = this.prepareContextUsageAttempt(input, observedLlm, safetyWriter);
        await this.piRunner.runTurn({
            ...toPiRunTurnInput(input),
            llm: contextUsageAttempt?.llm ?? observedLlm,
            systemPrompt,
            eventWriter: contextUsageAttempt?.eventWriter ?? safetyWriter,
            signal: combineAbortSignals(input.signal, safetyAbort.signal),
            captureToolTiming: getRuntimeBuildEnv() !== 'prod',
            eventIdGenerator: state.eventIdGenerator,
            runtimeSeqGenerator: state.runtimeSeqGenerator,
            toolConfig: {
                tools: input.tools ?? [],
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
            await appendCancelledTurn(input, state);
            return 'break';
        }
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
    async settleInputReview(input, state, inputRejected) {
        if (!inputRejected || state.retracted)
            return;
        state.retracted = true;
        state.retractionVariant ??= 'content';
        await appendSyntheticCompleted(input, `local-input-retracted-${input.turnId}-status`);
    }
    async reviewInput(input, observe) {
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
        try {
            const result = normalizeInputReviewResult(await this.options.reviewContent(input.reviewUserInput, 300));
            if (input.signal?.aborted)
                return false;
            const rejected = reviewBlocksInput(result);
            observe(rejected, inputReviewVariant(rejected, result.errorKind, input.contentReviewRequired === true), result.errorKind === 'api_error', result);
            reportInputReviewResolution(input, reviewBlocks(result));
            return rejected;
        }
        catch {
            if (input.signal?.aborted)
                return false;
            observe(true, 'network', false);
            reportInputReviewResolution(input, true);
            return true;
        }
    }
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
        inputSafetyReviewUnknown: false,
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
    if (state.retracted) {
        return {
            kind: 'output-recall',
            source: state.retractionSource ?? 'output-review',
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