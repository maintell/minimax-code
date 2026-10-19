import { logger } from '../common/logger.js';
import { PiTurnRunner } from '@mavis/agent-core/pi-turn-runner';
import { RuntimeEventStatus, RuntimeEventType } from '@mavis/protocol';
import { buildAbortedTerminalStatusEvent, buildCompletedTerminalStatusEvent, } from '@mavis/agent-core/event-bridge';
import { getRuntimeBuildEnv } from '@mavis/config';
import { BpeTokenEstimator } from '@mavis/context-manager';
import { reviewBlocks, SAFETY_SCENE } from '../content-safety/api.js';
import { createDesktopErrorReporter, createLLMFailureReportHook, } from '../error-reporting/index.js';
import { createLocalTurnEventReporting } from '../turns/event-reporter.js';
import { combineAbortSignals } from './abort-signals.js';
import { gateTerminalOnInputReview, waitForInputReview } from './input-safety-review.js';
import { writeSafetyReplacement } from './safety-replacement.js';
import { LocalOutputSafetyEventWriter } from './output-safety-writer.js';
import { OUTPUT_REVISION_INSTRUCTION, OUTPUT_SAFETY_MAX_REGENERATIONS, } from './output-safety-policy.js';
import { PI_TURN_RUNNER_LOGGER, withLlmResponseIdentifierLogging, } from './pi-turn-observability.js';
import { runLocalRuntimeEvalTurn } from './host-eval.js';
import { ContextUsageTurnTracker, withContextUsageEventWriter } from '../context/context-usage.js';
import { createContextUsageRuntime } from './context-usage-runtime.js';
const TOOL_CONTEXT_SIZE_ESTIMATOR = new BpeTokenEstimator();
export { deriveLocalRuntimeTurnOutcome, } from './turn-outcome.js';
export class LocalRuntimeHost {
    piRunner;
    outputSafetyMaxRegenerations;
    outputSafetyRetryDelay;
    reviewContent;
    metricsClient;
    evalReporterFactory;
    /**
     * 纯内存、故障不影响主流程的错误日志上报器。首期负责 LLM provider 失败：
     * 下方把失败 hook 注入 PiTurnRunner，使每次 LLM 物理请求失败都经旁路批量收集、
     * 加密并上传，不接触 turn 控制流。
     */
    errorReporter;
    contextUsageRuntime;
    constructor(options = {}) {
        // 先创建错误上报器，再把失败 hook 交给下方构造的 PiTurnRunner。上报器绑定实时认证
        // 来源，每个批次都读取最新登录 token；该 token 同时用于请求认证和派生本批次的
        // event_log 加密密钥。
        this.errorReporter =
            options.errorReporter ??
                createDesktopErrorReporter({
                    ...(options.authContextGetter ? { authContextGetter: options.authContextGetter } : {}),
                    ...(options.routingContextGetter
                        ? { routingContextGetter: options.routingContextGetter }
                        : {}),
                    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                });
        this.piRunner =
            options.piRunner ??
                new PiTurnRunner({
                    ...(options.metricsClient ? { metricsClient: options.metricsClient } : {}),
                    logger: PI_TURN_RUNNER_LOGGER,
                    toolContextSizeEstimator: TOOL_CONTEXT_SIZE_ESTIMATOR,
                    // 通过错误上报链路记录每次确认的 LLM 物理请求失败；包括重试，用户取消由
                    // agent-core 排除。
                    onLLMRequestFailure: options.llmRequestFailureHook ?? createLLMFailureReportHook(this.errorReporter),
                    ...(options.observeLLMRequest ? { observeLLMRequest: options.observeLLMRequest } : {}),
                });
        this.outputSafetyMaxRegenerations =
            options.outputSafetyMaxRegenerations ?? OUTPUT_SAFETY_MAX_REGENERATIONS;
        this.outputSafetyRetryDelay = options.outputSafetyRetryDelay;
        this.metricsClient = options.metricsClient;
        this.evalReporterFactory = options.evalReporterFactory;
        this.contextUsageRuntime = createContextUsageRuntime(options);
        // Bind the safety checker to the live auth source once, here — the review
        // call then only passes content + scene, never the access token per call.
        // One checker serves both directions: output windows (scene=StreamChunk /
        // MessageOutput / ThinkingContent) and the concurrent input review (scene=UserInput).
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
                    // Metrics must not change or mask the product-path outcome.
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
        const { reporter, eventIdGenerator, runtimeSeqGenerator } = createLocalTurnEventReporting({
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
        const toolContext = {
            ...baseToolContext,
            reporter,
        };
        // Tool duration is measured for the TUI / agent-message surfaces in non-prod
        // only. Prod turns never measure or expose per-tool duration.
        const captureToolTiming = getRuntimeBuildEnv() !== 'prod';
        const finishCancelledTurn = async (approvedPartial) => {
            await input.eventWriter.appendEvents([
                buildAbortedTerminalStatusEvent({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    statusEventId: `local-cancelled-${input.turnId}-status`,
                }),
            ]);
            return {
                events: input.eventWriter.events,
                frames: input.eventWriter.frames,
                eventWriter: input.eventWriter,
                retracted: false,
                networkStopped: false,
                ...(approvedPartial ? { approvedPartial } : {}),
            };
        };
        if (input.signal?.aborted)
            return finishCancelledTurn();
        const inputSafety = {
            rejected: false,
            correctionPending: false,
            replacement: undefined,
            guide: undefined,
            variant: undefined,
        };
        let currentSafetyWriter;
        // Review runs alongside generation; a late verdict interrupts the active draft.
        const inputReviewPending = (async () => {
            if (!input.reviewUserInput?.trim())
                return;
            try {
                const result = await this.reviewContent(input.reviewUserInput, SAFETY_SCENE.UserInput);
                if (input.signal?.aborted)
                    return;
                inputSafety.replacement = result.action === 'replace' ? result.suggestion : undefined;
                if (result.action === 'guide') {
                    inputSafety.guide = result.guide_prompt?.trim() || undefined;
                }
                inputSafety.rejected =
                    reviewBlocks(result) && !inputSafety.replacement && !inputSafety.guide;
                inputSafety.correctionPending = Boolean(inputSafety.rejected || inputSafety.replacement || inputSafety.guide);
                inputSafety.variant =
                    result.errorKind === 'local_error' || result.errorKind === 'auth_error'
                        ? 'network'
                        : 'content';
                if (inputSafety.correctionPending)
                    currentSafetyWriter?.block();
                input.onInputReviewResolved?.(reviewBlocks(result));
            }
            catch {
                if (input.signal?.aborted)
                    return;
                inputSafety.rejected = true;
                inputSafety.correctionPending = true;
                inputSafety.variant = 'network';
                currentSafetyWriter?.block();
                input.onInputReviewResolved?.(true);
            }
        })();
        const inputReviewSettled = waitForInputReview(inputReviewPending, input.signal);
        // Output-review regeneration loop — 纯同步「先审后发」. The local daemon has
        // no archon-server to orchestrate rewind/retry, so the host owns the loop.
        // Each attempt wraps the live sink in a `LocalOutputSafetyEventWriter` that
        // reviews output before forwarding and, on a violation, sets `blocked`
        // (never throws — pi swallows writer exceptions) and aborts generation early
        // via an internal AbortController. After `runTurn` resolves the host reads
        // `blocked`:
        //   not blocked            → approved content already streamed live; done.
        //   blocked, budget left   → recall the streamed partial + rewind pi history,
        //                            then regenerate with the neutral instruction.
        //   blocked, budget spent  → give up: close with a COMPLETED terminal (no
        //                            assistant bubble) and signal `retracted` so the
        //                            orchestration layer retracts the whole turn.
        // `blocked` / `safetyAbort` / the writer buffers are per-attempt locals, so
        // they can never leak across attempts, turns or sessions. Total worst-case
        // pi runs = 1 initial + maxRegens.
        const maxRegenerations = this.outputSafetyMaxRegenerations;
        const observedLlm = withLlmResponseIdentifierLogging(input.llm, {
            sessionId: input.sessionId,
            turnId: input.turnId,
        });
        let retracted = false;
        let networkStopped = false;
        let approvedPartial;
        let retractionVariant;
        let finalAttemptEventStart = input.eventWriter.events.length;
        // A guide is consumed by exactly one subsequent generation attempt.
        let pendingGuidePrompt;
        const abortSafetyAttempt = (controller) => {
            controller.abort(inputSafety.correctionPending ? 'input_safety' : 'output_safety');
        };
        for (let regenerationCount = 0; regenerationCount <= maxRegenerations; regenerationCount += 1) {
            const isRegeneration = regenerationCount > 0;
            const safetyAbort = new AbortController();
            const safetyWriter = new LocalOutputSafetyEventWriter(input.eventWriter, {
                checkText: (content, scene) => this.reviewContent(content, scene),
                onBlocked: () => abortSafetyAttempt(safetyAbort),
                ...(this.outputSafetyRetryDelay ? { retryDelay: this.outputSafetyRetryDelay } : {}),
                ...(this.metricsClient ? { metricsClient: this.metricsClient } : {}),
                ...(input.persistApprovedPartialOnNetworkStop === false
                    ? { persistApprovedPartialOnNetworkStop: false }
                    : {}),
            });
            currentSafetyWriter = safetyWriter;
            if (inputSafety.correctionPending)
                safetyWriter.block();
            const attemptWriter = gateTerminalOnInputReview(safetyWriter, inputReviewSettled, () => inputSafety.correctionPending, input.signal);
            finalAttemptEventStart = input.eventWriter.events.length;
            if (isRegeneration)
                observation.regenerations += 1;
            const contextUsageTracker = input.contextUsagePromptRanges
                ? new ContextUsageTurnTracker(observedLlm.model.contextWindow, input.contextUsagePromptRanges, input.onContextUsageDebug, this.contextUsageRuntime.calibrationCoordinator, this.contextUsageRuntime.providerDiagnosticCounter, input.contextUsageRequiresProviderAnchor)
                : undefined;
            // A guide replaces the default SR for one model attempt only.
            const revisionInstruction = pendingGuidePrompt ?? OUTPUT_REVISION_INSTRUCTION;
            const applyRevision = isRegeneration || pendingGuidePrompt !== undefined;
            pendingGuidePrompt = undefined;
            await this.piRunner.runTurn({
                ...input,
                llm: contextUsageTracker
                    ? {
                        ...observedLlm,
                        streamFn: contextUsageTracker.wrapStreamFn(observedLlm.streamFn),
                    }
                    : observedLlm,
                systemPrompt: applyRevision
                    ? `${input.systemPrompt}\n\n${revisionInstruction}`
                    : input.systemPrompt,
                eventWriter: contextUsageTracker
                    ? withContextUsageEventWriter(attemptWriter, contextUsageTracker)
                    : attemptWriter,
                llmRetry: {
                    ...(input.onLlmRetry ? { observer: input.onLlmRetry } : {}),
                },
                signal: combineAbortSignals(input.signal, safetyAbort.signal),
                captureToolTiming,
                eventIdGenerator,
                runtimeSeqGenerator,
                toolConfig: {
                    tools: input.tools,
                    disableBuiltinToolFallback: input.disableBuiltinToolFallback,
                    context: toolContext,
                },
            });
            await inputReviewSettled;
            if (input.signal?.aborted &&
                !input.eventWriter.events
                    .slice(finalAttemptEventStart)
                    .some((event) => event.type === RuntimeEventType.SESSION_STATUS &&
                    event.payload?.status === RuntimeEventStatus.ABORTED))
                return finishCancelledTurn(safetyWriter.getApprovedPartial());
            if (inputSafety.rejected) {
                retracted = true;
                retractionVariant = inputSafety.variant;
                await input.eventWriter.appendEvents([
                    buildCompletedTerminalStatusEvent({
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        statusEventId: `local-input-retracted-${input.turnId}-status`,
                    }),
                ]);
                break;
            }
            if (inputSafety.correctionPending &&
                (inputSafety.replacement || !safetyWriter.immediateBlock)) {
                await input.onOutputRecall?.();
                await input.rewindPiHistory?.();
                if (inputSafety.replacement) {
                    if (!(await writeSafetyReplacement(input, inputSafety.replacement))) {
                        return finishCancelledTurn();
                    }
                    break;
                }
                if (input.signal?.aborted)
                    return finishCancelledTurn();
                pendingGuidePrompt = inputSafety.guide;
                inputSafety.correctionPending = false;
                // Correcting a late input guide does not consume the output retry budget.
                regenerationCount -= 1;
                continue;
            }
            // Output review could not reach a verdict (safety gateway kept returning
            // `local_error` past the in-writer retries): soft-stop, NOT a retract. The
            // approved windows already streamed live this attempt stay; the writer
            // already dropped the un-approved window. Close the turn with a COMPLETED
            // terminal (keeps the streamed content) and signal `networkStopped` so the
            // orchestration only arms the NETWORK notice — never dropping the user
            // query bubble or rewinding pi history. Checked BEFORE `blocked` because
            // a soft-stop must never fall into the content retraction / regenerate path.
            if (safetyWriter.networkStopped) {
                // A runner failure is more specific than the simultaneous safety
                // transport failure. Its FAILED terminal was already forwarded by the
                // writer, so keep it authoritative and do not append a synthetic
                // COMPLETED/network-notice outcome.
                if (safetyWriter.terminalFailed)
                    break;
                logger.warn({
                    sessionId: input.sessionId,
                    turnId: input.turnId,
                    reviewOutcome: 'unavailable',
                    outputSuppressed: true,
                    terminalStatus: 'completed',
                }, '[content-safety] output review stopped turn');
                networkStopped = true;
                retractionVariant = 'network';
                // Capture the approved prefix so the orchestration can rewrite pi history
                // (the ungated history lane already persisted pi's full output).
                approvedPartial = safetyWriter.getApprovedPartial();
                await input.eventWriter.appendEvents([
                    buildCompletedTerminalStatusEvent({
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        statusEventId: `local-output-network-stopped-${input.turnId}-status`,
                    }),
                ]);
                break;
            }
            // Guide blocks this draft and supplies only the next attempt's instruction.
            const guideReviewed = safetyWriter.guideReviewed;
            const blocked = safetyWriter.blocked;
            if (guideReviewed) {
                pendingGuidePrompt = safetyWriter.consumeGuidePrompt();
            }
            if (!blocked && !guideReviewed) {
                // Clean pass (or user abort): approved output already streamed live.
                // Snapshot the approved (user-visible) prefix so the orchestration can
                // reconcile pi history on a user abort — the ungated history lane may
                // have persisted an unfinished assistant whose tail was never reviewed.
                // Harmless on a clean completion (approvedContent == the full reviewed
                // message, so the orchestration's abort-only rewrite never fires).
                approvedPartial = safetyWriter.getApprovedPartial();
                break;
            }
            if (safetyWriter.immediateBlock || regenerationCount >= maxRegenerations) {
                retracted = true;
                // 输出复审耗尽重生次数后放弃：这是真·内容政策拦截，所以提示
                // 面向内容，而非网络。
                retractionVariant = 'content';
                await input.eventWriter.appendEvents([
                    buildCompletedTerminalStatusEvent({
                        sessionId: input.sessionId,
                        turnId: input.turnId,
                        statusEventId: `local-output-retracted-${input.turnId}-status`,
                    }),
                ]);
                break;
            }
            // Budget remains: recall the streamed partial from the UI, drop the leaked
            // draft from pi history, then regenerate on a clean pre-turn snapshot.
            // Review retries use the supplied guide or the existing SR fallback.
            await input.onOutputRecall?.();
            await input.rewindPiHistory?.();
        }
        return {
            events: input.eventWriter.events,
            frames: input.eventWriter.frames,
            eventWriter: input.eventWriter,
            retracted,
            networkStopped,
            ...((retracted || networkStopped) && retractionVariant ? { retractionVariant } : {}),
            ...(approvedPartial ? { approvedPartial } : {}),
            ...(finalAttemptEventStart > 0 ? { timingEventsStartIndex: finalAttemptEventStart } : {}),
        };
    }
}
//# sourceMappingURL=host.js.map