import { PiTurnRunner } from '@mavis/agent-core/pi-turn-runner';
import { getRuntimeBuildEnv } from '@mavis/config';
import { BpeTokenEstimator } from '@mavis/context-manager';
import { createDesktopErrorReporter, createLLMFailureReportHook, } from '../../../infra/error-reporting/index.js';
import { createLocalTurnEventReporting } from '../file-changes/event-reporter.js';
import { combineAbortSignals } from './abort-signals.js';
import { gateTerminalOnInputReview, waitForInputReview } from '../safety/input-safety-review.js';
import { reviewTurnInput } from '../safety/host-input-review.js';
import { finishSafetyAttempt, finishCancelledTurn, buildSafetyTurnOutput, } from '../safety/host-safety-attempt.js';
import { LocalOutputSafetyEventWriter } from '../safety/output-safety-writer.js';
import { OUTPUT_REVISION_INSTRUCTION, OUTPUT_SAFETY_MAX_REGENERATIONS, } from '../safety/output-safety-policy.js';
import { PI_TURN_RUNNER_LOGGER, withLlmResponseIdentifierLogging, } from './reporting/pi-turn-observability.js';
import { runLocalRuntimeEvalTurn } from './reporting/host-eval.js';
import { ContextUsageTurnTracker, withContextUsageEventWriter, } from '../context-usage/context-usage-turn-tracker.js';
import { createContextUsageRuntime } from './context-usage-runtime.js';
export { deriveLocalRuntimeTurnOutcome } from './reporting/turn-outcome.js';
const TOOL_CONTEXT_SIZE_ESTIMATOR = new BpeTokenEstimator();
export class LocalRuntimeHost {
    piRunner;
    outputSafetyMaxRegenerations;
    outputSafetyRetryDelay;
    reviewContent;
    metricsClient;
    evalReporterFactory;
    errorReporter;
    contextUsageRuntime;
    constructor(options = {}) {
        // 上报器绑定实时认证来源；失败 hook 旁路收集，不改变 turn 控制流。
        this.errorReporter = options.errorReporter ?? buildErrorReporter(options);
        this.piRunner =
            options.piRunner ??
                new PiTurnRunner({
                    ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
                    logger: PI_TURN_RUNNER_LOGGER,
                    toolContextSizeEstimator: TOOL_CONTEXT_SIZE_ESTIMATOR,
                    onLLMRequestFailure: options.llmRequestFailureHook ?? createLLMFailureReportHook(this.errorReporter),
                    ...(options.observeLLMRequest ? { observeLLMRequest: options.observeLLMRequest } : {}),
                });
        this.outputSafetyMaxRegenerations =
            options.outputSafetyMaxRegenerations ?? OUTPUT_SAFETY_MAX_REGENERATIONS;
        this.outputSafetyRetryDelay = options.outputSafetyRetryDelay;
        this.metricsClient = options.metricsClient;
        this.evalReporterFactory = options.evalReporterFactory;
        this.contextUsageRuntime = createContextUsageRuntime(options);
        this.reviewContent =
            options.reviewContent ?? (async () => ({ pass: false, errorKind: 'local_error' }));
    }
    async runTurn(input) {
        const isUserTurn = input.reviewUserInput !== undefined &&
            (input.caller === undefined || input.caller === 'chat' || input.caller === 'channel_feishu');
        const observation = { regenerations: 0 };
        try {
            return await this.runTurnCore(input, observation);
        }
        finally {
            if (isUserTurn) {
                try {
                    this.metricsClient?.histogram('output_safety_regenerations_per_user_turn', observation.regenerations, {
                        provider: String(input.llm.model.provider),
                        model: String(input.llm.model.id),
                        caller: input.caller ?? 'unknown',
                    });
                }
                catch {
                    // 指标不能改变或掩盖产品路径结果。
                }
            }
        }
    }
    runTurnCore(input, observation) {
        return runLocalRuntimeEvalTurn({
            input,
            reporterFactory: this.evalReporterFactory,
            execute: (evalInput) => this.executeTurn(evalInput, observation),
        });
    }
    async executeTurn(input, observation) {
        const execution = prepareTurnExecution(input);
        if (input.signal?.aborted)
            return finishCancelledTurn(input);
        const inputSafety = { rejected: false, correctionPending: false };
        let currentSafetyWriter;
        // 输入审核与生成并发，晚到裁定只阻断当前 draft。
        const inputReviewPending = reviewTurnInput({
            turn: input,
            state: inputSafety,
            review: (content, scene) => this.reviewContent(content, scene),
            blockCurrent: () => currentSafetyWriter?.block(),
        });
        const inputReviewSettled = waitForInputReview(inputReviewPending, input.signal);
        const observedLlm = withLlmResponseIdentifierLogging(input.llm, {
            sessionId: input.sessionId,
            turnId: input.turnId,
        });
        let finalAttemptEventStart = input.eventWriter.events.length;
        let pendingGuidePrompt;
        for (let regenerationCount = 0; regenerationCount <= this.outputSafetyMaxRegenerations; regenerationCount += 1) {
            const safetyAbort = new AbortController();
            const safetyWriter = this.createSafetyWriter(input, () => {
                safetyAbort.abort(inputSafety.correctionPending ? 'input_safety' : 'output_safety');
            });
            currentSafetyWriter = safetyWriter;
            if (inputSafety.correctionPending)
                safetyWriter.block();
            const attemptWriter = gateTerminalOnInputReview(safetyWriter, inputReviewSettled, () => inputSafety.correctionPending, input.signal);
            finalAttemptEventStart = input.eventWriter.events.length;
            const isRegeneration = regenerationCount > 0;
            if (isRegeneration)
                observation.regenerations += 1;
            const guide = pendingGuidePrompt;
            pendingGuidePrompt = undefined;
            await this.runGeneration({
                turn: input,
                execution,
                observedLlm,
                attemptWriter,
                safetyAbort,
                isRegeneration,
                guide,
            });
            await inputReviewSettled;
            const decision = await finishSafetyAttempt({
                turn: input,
                inputSafety,
                writer: safetyWriter,
                regenerationCount,
                maxRegenerations: this.outputSafetyMaxRegenerations,
                eventStart: finalAttemptEventStart,
            });
            if (decision.kind === 'cancel')
                return finishCancelledTurn(input, decision.approvedPartial);
            if (decision.kind === 'finish')
                return buildSafetyTurnOutput(input, decision.output, finalAttemptEventStart);
            pendingGuidePrompt = decision.guide;
            if (decision.inputCorrection)
                regenerationCount -= 1;
        }
        return buildSafetyTurnOutput(input, { retracted: false, networkStopped: false }, finalAttemptEventStart);
    }
    createSafetyWriter(input, onBlocked) {
        return new LocalOutputSafetyEventWriter(input.eventWriter, {
            checkText: (content, scene) => this.reviewContent(content, scene),
            onBlocked,
            ...(this.outputSafetyRetryDelay ? { retryDelay: this.outputSafetyRetryDelay } : {}),
            ...(this.metricsClient ? { metricsClient: this.metricsClient } : {}),
            ...(input.persistApprovedPartialOnNetworkStop === false
                ? { persistApprovedPartialOnNetworkStop: false }
                : {}),
        });
    }
    async runGeneration(input) {
        const { turn, observedLlm, execution } = input;
        const tracker = turn.contextUsagePromptRanges
            ? new ContextUsageTurnTracker(observedLlm.model.contextWindow, turn.contextUsagePromptRanges, turn.onContextUsageDebug, this.contextUsageRuntime.calibrationCoordinator, this.contextUsageRuntime.providerDiagnosticCounter, turn.contextUsageRequiresProviderAnchor)
            : undefined;
        const revisionInstruction = input.guide ?? OUTPUT_REVISION_INSTRUCTION;
        const applyRevision = input.isRegeneration || input.guide !== undefined;
        await this.piRunner.runTurn({
            ...turn,
            llm: tracker
                ? { ...observedLlm, streamFn: tracker.wrapStreamFn(observedLlm.streamFn) }
                : observedLlm,
            systemPrompt: applyRevision
                ? `${turn.systemPrompt}\n\n${revisionInstruction}`
                : turn.systemPrompt,
            eventWriter: tracker
                ? withContextUsageEventWriter(input.attemptWriter, tracker)
                : input.attemptWriter,
            llmRetry: { ...(turn.onLlmRetry ? { observer: turn.onLlmRetry } : {}) },
            signal: combineAbortSignals(turn.signal, input.safetyAbort.signal),
            captureToolTiming: execution.captureToolTiming,
            eventIdGenerator: execution.reporting.eventIdGenerator,
            runtimeSeqGenerator: execution.reporting.runtimeSeqGenerator,
            toolConfig: {
                tools: turn.tools,
                disableBuiltinToolFallback: turn.disableBuiltinToolFallback,
                context: execution.toolContext,
            },
        });
    }
}
function prepareTurnExecution(input) {
    const reporting = createLocalTurnEventReporting({
        turnId: input.turnId,
        eventWriter: {
            appendEvents: async (events) => {
                await input.eventWriter.appendEvents(events);
            },
        },
        ...(input.eventIdGenerator ? { eventIdGenerator: input.eventIdGenerator } : {}),
        ...(input.runtimeSeqGenerator ? { runtimeSeqGenerator: input.runtimeSeqGenerator } : {}),
    });
    const baseToolContext = input.toolContext ?? { sessionId: input.sessionId, turnId: input.turnId };
    return {
        reporting,
        toolContext: { ...baseToolContext, reporter: reporting.reporter },
        captureToolTiming: getRuntimeBuildEnv() !== 'prod',
    };
}
function buildErrorReporter(options) {
    return createDesktopErrorReporter({
        ...(options.authContextGetter ? { authContextGetter: options.authContextGetter } : {}),
        ...(options.routingContextGetter ? { routingContextGetter: options.routingContextGetter } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
}
//# sourceMappingURL=host.js.map