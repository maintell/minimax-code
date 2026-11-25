import { CommittedReplyRelay } from './turn-state-layer/committed-reply.js';
import { hasSendToUserTool, createBunnyReplyOriginTracker, createPlainTextEndingFollowUp, withPlainTextEndingHook, } from '../runner/output/send-to-user-display-projection.js';
import { createContinuationControl, resolveChildBashSteeringContext, waitsForChildBash, prepareInitialImmediateSendBatch, preparePlainSteering, userSteeringToolContext, withGenuineQueryProvenance, } from './user-input-control.js';
import { createTurnSideEventRouter } from '../events/turn-side-event-router.js';
import { writeTurnFaultLateOutput } from '../events/turn-fault-late-output.js';
import { isBunnyMainConversationTurn, preemptionRunOption, startUserSteeringPreemption, } from './user-steering-preemption.js';
import { agentKindField, toPiUserMessage, wakeField, } from '@mavis/agent-core/pi-turn-runner';
import {} from '@mavis/agent-core/tools';
import { readTrustedAgentCoordination } from '../assembly/local-turn-tool-catalog-source.js';
import { buildCompletedTerminalStatusEvent, buildRuntimeWarningEvent, } from '@mavis/agent-core/event-bridge';
import { withPtcCompactionReminder } from './ptc/compaction-reminder.js';
import { createPtcTurnCompactionReminder, observePtcTurnAdmission, preparePtcExecution, } from './ptc/turn-preparation.js';
import { createToolSearchContextHook, createToolSearchResponseHook } from '../tools/tool-search.js';
import { createSkillCatalogContextHook, createSkillCatalogResponseHook, } from '../tools/skill-catalog-window.js';
import { observePromptSectionChange } from '../runner/observability/prompt-section-change.js';
import { createLocalPluginHookEventReporter, LocalPluginHooks, } from '../assembly/local-turn-plugin-hooks.js';
import { PtcPrefixBaselines } from '../runner/observability/ptc-prefix-fingerprint.js';
import { copyCanonicalHistoryForPiCompatibility } from '../history/canonical-history-validation.js';
import { coordinatorSteeringOptions, resolveTurnPrefix } from './turn-state-layer/turn-state.js';
import { assertLocalOutputFormatCapability, buildTurnPayloadTransforms, resolveCoordinatorGenuineUserQueryText, } from '../assembly/payload/local-turn-payload-transform.js';
import { AgentHostDependencyUnavailableError } from '../empty-dependencies.js';
import { createLocalTurnEventWriter, } from '../events/runtime-event-writer.js';
import { inputReviewRunnerOptions } from '../runner/policy/input-review-runner-options.js';
import { applyProcessLocalToolResultPolicy } from '../runner/policy/process-local-tool-result-policy.js';
import { joinPrompt, joinUserPrompt, isLightweightRootSession, readPreparedContextUsagePromptRanges, readPreparedSystemPrompt, renderAgentRuntimeReminders, resolveProviderContextMode, turnUserPromptPrefix, } from './prompt.js';
import {} from '../tools/index.js';
import { withPluginAutomaticCompactionLifecycle } from './model-hooks/plugin-hook-compaction-lifecycle.js';
import { createControlledToolHooks } from './plugin-hook-tool-lifecycle.js';
import { toolSearchContextHooks } from './model-hooks/tool-search-context.js';
import { createRequestOnlyReminderHook } from './model-hooks/request-only-reminders.js';
import { prepareTurnReminders } from './model-hooks/execution-reminders.js';
import { createTurnPromptSuggestionCapture, PromptSuggestionCommitRelay, readPromptSuggestionScope, withPromptSuggestionHooks, } from '../runner/prompt-suggestion/capture.js';
import { cleanupPluginHookTranscriptBestEffort, lightweightToolCallFallback, pluginHookTranscriptCleanup, pluginToolContext, resolvePluginHookSessionOwnershipClaim, } from './model-hooks/plugin-subagent-lifecycle.js';
import { withExecutionObservability } from './model-hooks/execution-observability.js';
import { withProviderRequestDiagnostics } from '../runner/observability/provider-request-diagnostics.js';
import { ackCommittedToolResultTailClaims, attachCommittedFacts, attachWaitingForUser, continuationRunMode, contentReviewOptions, createInitialHookInput, describeUnknownError, hostOutputTokenCap, preparedTurnTiming, providerHistory, reconcileIntent, requestControlledRunOptions, turnYieldRunOptions, userTypedTurnField, } from './turn-execution-policy.js';
import { validateOptions, validateResolvedInput, validateRoutedTurnTools, } from './executor-validation.js';
async function emitComputerUseDefaultWarning(input, reporter) {
    if (input.preparation.agentConfig.computerUseDefaultUnavailable !== true)
        return;
    try {
        await reporter.appendEvents([
            buildRuntimeWarningEvent({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                eventId: reporter.nextEventId('runtime_warning'),
                runtimeSeq: reporter.nextRuntimeSeq(),
                source: 'computer-use',
                category: 'diagnostic',
                code: 'COMPUTER_USE_DEFAULT_UNAVAILABLE',
                message: 'Computer Use could not be enabled for this turn. The conversation will continue without computer control.',
            }),
        ]);
    }
    catch {
        // A failed warning must not turn best-effort default activation into a failed chat.
    }
}
/**
 * Host-owned orchestration around a neutral runtime port. All work that can
 * fail before runtime invocation stays inside `execute()`, so LocalAgentHost
 * can commit exactly one failed terminal before receipt/release.
 */
export class LocalRuntimeTurnExecutor {
    options;
    committedReplies = new CommittedReplyRelay(() => this.options.onReplyCommitted);
    promptSuggestions = new PromptSuggestionCommitRelay(() => this.options.promptSuggestion);
    pluginHooks;
    ptcPrefixBaselines;
    prepareBashTools;
    constructor(options) {
        this.options = options;
        validateOptions(options);
        this.pluginHooks = options.pluginHooks ?? new LocalPluginHooks();
        this.ptcPrefixBaselines = options.ptcPrefixBaselines ?? new PtcPrefixBaselines();
        this.prepareBashTools = options.prepareBashTools ?? ((tools) => tools);
    }
    async execute(input) {
        let unboundPluginHookTranscriptCleanup;
        try {
            const eventWriter = createLocalTurnEventWriter(input, this.options.projectRuntimeEvent);
            const pluginHookEventReporter = createLocalPluginHookEventReporter({
                writer: eventWriter,
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                ...continuationLeaseOf(input),
                ...(this.options.tuiProductPolicy === true
                    ? { terminalSequenceSurface: 'tui' }
                    : {}),
            });
            const pluginHookProjection = input.pluginHooks?.length
                ? await this.resolvePluginHookProjection(input)
                : { runtimeContext: this.resolvePluginHookRuntimeContext(input) };
            const pluginHookTranscriptWriter = pluginHookProjection.writer;
            unboundPluginHookTranscriptCleanup = pluginHookTranscriptCleanup(pluginHookTranscriptWriter);
            const pluginHookRuntimeContext = pluginHookProjection.runtimeContext;
            const contextualInput = input.pluginHooks?.length
                ? {
                    ...input,
                    pluginHookRuntimeContext,
                    pluginHookEventReporter,
                    ...(pluginHookTranscriptWriter ? { pluginHookTranscriptWriter } : {}),
                }
                : { ...input, pluginHookEventReporter };
            const clearPluginHookSessionPermissions = this.options.clearPluginHookSessionPermissions;
            const sessionOwnershipClaim = resolvePluginHookSessionOwnershipClaim(this.options.preparePluginHookSessionOwnership, input.lease.leaseId);
            if (sessionOwnershipClaim) {
                await this.options.preparePluginHookSessionOwnership?.({
                    sessionId: input.lease.sessionId,
                    turnId: input.lease.turnId,
                    ownershipClaimId: sessionOwnershipClaim,
                });
            }
            const admission = await this.pluginHooks.beginTurn(contextualInput, {
                ...pluginHookRuntimeContext,
                ...(pluginHookTranscriptWriter
                    ? { transcriptCleanup: () => pluginHookTranscriptWriter.cleanup() }
                    : {}),
                ...(clearPluginHookSessionPermissions
                    ? {
                        sessionEndCleanup: () => clearPluginHookSessionPermissions(input.lease.sessionId),
                    }
                    : {}),
            });
            unboundPluginHookTranscriptCleanup = undefined;
            await this.commitPluginHookAdmission(input, admission.transaction, sessionOwnershipClaim);
            if (admission.kind !== 'continue') {
                if (admission.kind === 'deny')
                    throw new Error(admission.reason);
                await eventWriter.pushRuntime(buildCompletedTerminalStatusEvent({
                    sessionId: input.lease.sessionId,
                    turnId: input.lease.turnId,
                    statusEventId: `${input.lease.turnId}:plugin-hook-stop`,
                }));
                return input.resolveTerminalOutcome();
            }
            await emitComputerUseDefaultWarning(input, pluginHookEventReporter);
            return await this.executeTurn(admission.input, eventWriter);
        }
        finally {
            await cleanupPluginHookTranscriptBestEffort(unboundPluginHookTranscriptCleanup);
            this.pluginHooks.coordinator.resumeIdleCountdown(input.lease.sessionId);
        }
    }
    async commitPluginHookAdmission(input, transaction, sessionOwnershipClaim) {
        if (!sessionOwnershipClaim) {
            await transaction.commit();
            return;
        }
        const pluginHookCoordinator = this.pluginHooks.coordinator;
        const previousSessionOwnershipClaim = pluginHookCoordinator.bindSessionOwnershipClaim(input.lease.sessionId, sessionOwnershipClaim);
        try {
            await this.options.activatePluginHookSessionOwnership?.({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                ownershipClaimId: sessionOwnershipClaim,
            });
            await transaction.commit();
        }
        catch (error) {
            pluginHookCoordinator.rollbackSessionOwnershipClaim(input.lease.sessionId, sessionOwnershipClaim, previousSessionOwnershipClaim);
            await transaction.rollback();
            throw error;
        }
    }
    resolvePluginHookRuntimeContext(input) {
        const host = input.pluginHookRuntimeContext ??
            this.options.resolvePluginHookRuntimeContext?.(input.session) ??
            {};
        return {
            ...host,
            model: input.preparation.llm.model.id,
            promptId: input.lease.turnId,
        };
    }
    async resolvePluginHookProjection(input) {
        const runtimeContext = this.resolvePluginHookRuntimeContext(input);
        if (!runtimeContext.transcriptPath)
            return { runtimeContext };
        try {
            const writer = await this.pluginHooks.createTranscript({
                cwd: input.session.workspaceDir,
                sessionId: input.lease.sessionId,
                messages: copyCanonicalHistoryForPiCompatibility(input.history.messages),
            });
            return {
                writer,
                runtimeContext: {
                    ...runtimeContext,
                    transcriptPath: writer.path,
                    codexTranscriptPath: writer.codexPath,
                },
            };
        }
        catch {
            return {
                runtimeContext: {
                    ...runtimeContext,
                    transcriptPath: null,
                    codexTranscriptPath: null,
                },
            };
        }
    }
    async executeTurn(input, eventWriter) {
        const prepared = await this.prepareRunnerInput(input, eventWriter);
        // Verification-only (S14#4): an abort here ends the Turn cancelled before any history write.
        const late = await this.options.turnFaults?.holdBeforeHistory(input.lease);
        // Verification-only (Bunny context reset S03): output a Turn writes after it was ended by force.
        if (late)
            await writeTurnFaultLateOutput(input, late.lateText);
        const outputContract = input.request.outputContract;
        assertLocalOutputFormatCapability(input.preparation.llm.model, outputContract, input.preparation.llm.supportsJsonObjectOutput === true);
        await this.beginFileChanges(input);
        let settled;
        try {
            settled = await this.runPreparedTurn(input, prepared, eventWriter, outputContract);
        }
        catch (error) {
            return this.throwWithFileFailure(input, error);
        }
        return this.settleTurn(input, settled);
    }
    async runPreparedTurn(input, prepared, eventWriter, outputContract) {
        input.control.setComputerUseAvailable?.(prepared.tools.some((tool) => tool.def.name.startsWith('computer_')));
        const pendingToolResultTailClaims = new Set();
        const readTaskOutputTaskIds = prepared.readTaskOutputTaskIds;
        const savedPtcScripts = prepared.savedPtcScripts;
        const terminalTaskOutputReadIds = new Set();
        const repliesThroughSendToUser = hasSendToUserTool(prepared.tools);
        const replies = createBunnyReplyOriginTracker(input.request, repliesThroughSendToUser);
        const plainTextEnding = createPlainTextEndingFollowUp(input, repliesThroughSendToUser, isBunnyMainConversationTurn(input));
        const continuation = createContinuationControl(input, prepared.prepareSteering, (consumed) => {
            preemption?.recordConsumedSteering(consumed.message, {
                hookDenied: consumed.hookDenied === true,
            });
            plainTextEnding?.recordConsumedSteering(consumed.message);
            return this.options.onSteeringConsumed?.(consumed);
        }, {
            coordinator: this.pluginHooks.coordinator,
            ...coordinatorSteeringOptions(input, prepared, this.options.turnStateLayer?.()),
            onAcceptedInput: replies?.accept,
        });
        const toolSafetyGuard = this.options.createTurnToolSafetyGuard?.();
        const payloadTransforms = buildTurnPayloadTransforms(input, outputContract, this.options);
        // Short-lived internal state. When the feature is off nothing is captured
        // and no extra Hook is installed, so the main Turn behaves exactly as before.
        const promptSuggestion = createTurnPromptSuggestionCapture(input, prepared, this.options);
        const childBash = this.options.createChildBashLifecycle?.({
            session: input.session,
            turnId: input.lease.turnId,
            signal: input.lease.signal,
        });
        // Preemption side events share Pi's runtime sequence, so they must share
        // the attempt's safety writer instead of the Turn writer.
        const sideEventRouter = createTurnSideEventRouter(eventWriter);
        const preemption = startUserSteeringPreemption(input, this.options.logger, sideEventRouter);
        let runnerResult;
        const evalSessionFields = this.projectEvalSessionFields(input.session, input.lease.sessionId);
        try {
            runnerResult = await this.options.runtime.runTurn({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                workspaceDir: input.session.workspaceDir,
                ...(evalSessionFields ? { evalSessionFields } : {}),
                systemPrompt: prepared.systemPrompt,
                promptMetadata: input.preparation.agentConfig.prompt_metadata,
                userMessage: prepared.userMessage,
                replyOrigin: replies?.current,
                ...(prepared.beforeUserMessages.length > 0
                    ? { beforeUserMessages: prepared.beforeUserMessages }
                    : {}),
                outputRevisionInstruction: input.preparation.outputRevisionInstruction,
                ...continuationRunMode(input),
                ...turnYieldRunOptions(input),
                ...userTypedTurnField(input),
                ...inputReviewRunnerOptions(input, this.options.onInputReviewResolved),
                ...contentReviewOptions(input, this.options),
                ...(this.options.tuiProductPolicy === true ? { deferInputReviewResolution: true } : {}),
                llm: {
                    ...prepared.llm,
                    ...hostOutputTokenCap(this.options.outputTokenCap, input),
                    ...payloadTransforms,
                    streamFn: withProviderRequestDiagnostics(prepared.llm.streamFn, {
                        sessionId: input.lease.sessionId,
                        turnId: input.lease.turnId,
                        logger: this.options.logger,
                    }),
                },
                eventWriter,
                ...toolCallContentOption(input),
                eventIdGenerator: input.pluginHookEventReporter?.nextEventId,
                runtimeSeqGenerator: input.pluginHookEventReporter?.nextRuntimeSeq,
                sideEventRouter,
                history: prepared.history,
                signal: input.lease.signal,
                tools: prepared.tools,
                ...(prepared.ptcTools ? { ptcTools: prepared.ptcTools } : {}),
                disableBuiltinToolFallback: prepared.toolResolution.disableBuiltinToolFallback,
                toolContext: prepared.toolContext,
                hooks: withExecutionObservability(withPromptSuggestionHooks(mergeHooks({
                    input,
                    pluginHookCoordinator: this.pluginHooks.coordinator,
                    toolResolution: prepared.toolResolution,
                    pendingToolResultTailClaims,
                    hostBeforeLlmCallHooks: prepared.beforeLlmCallHooks,
                    hostAfterLlmCallHooks: withPlainTextEndingHook(prepared.afterLlmCallHooks, plainTextEnding),
                    readTaskOutputTaskIds,
                    savedPtcScripts,
                    ptcObserver: prepared.ptcObserver,
                    terminalTaskOutputReadIds,
                    toolsDisabled: this.options.disableTools === true,
                    toolSafetyGuard,
                    toolPolicyGuard: this.options.toolPolicyGuard,
                    finalizeToolResultForHistory: this.options.finalizeToolResultForHistory,
                    ptcFactCollector: prepared.ptcFactCollector,
                    reportCommittedHistory: (messages) => this.reportUserMessageSubmitted(input, prepared.userMessage, messages),
                    toolContentReview: this.options.toolContentReview,
                    deferredExecutionReason: this.pluginHooks.deferredExecutionReason,
                }), promptSuggestion?.capture), input.request.provenance.sourceContext?.executionDiagnostics === true),
                caller: prepared.caller,
                ...agentKindField(prepared.agentKind),
                ...wakeField(prepared.wake),
                ...(prepared.unexpectedToolCallFallback
                    ? { unexpectedToolCallFallback: prepared.unexpectedToolCallFallback }
                    : {}),
                getSteeringMessages: async (context) => {
                    for (;;) {
                        // Subscribe before draining so an append racing the wait cannot be missed.
                        const steeringSignal = input.control.steeringSignal?.();
                        const steeringContext = await resolveChildBashSteeringContext(context, childBash);
                        const messages = (await continuation.getSteeringMessages?.(steeringContext)) ?? [];
                        const notice = await childBash?.poll({
                            wait: waitsForChildBash(context, messages.length, continuation),
                            readTaskIds: terminalTaskOutputReadIds,
                            onWaitingChanged: input.control.setBackgroundTaskWaiting,
                            ...(steeringSignal ? { steeringSignal } : {}),
                        });
                        if (notice)
                            return [...messages, toPiUserMessage({ text: notice })];
                        if (messages.length > 0 || !childBash || !steeringSignal?.aborted)
                            return messages;
                    }
                },
                shouldStopAfterSteering: continuation.shouldStopAfterSteering,
                tryBeginClose: continuation.tryBeginClose,
                ...(await requestControlledRunOptions(input, this.options)),
                ...preparedTurnTiming(input.turnTiming, this.options.nowMs),
                // Desktop and TUI both consume provider-measured output throughput.
                ...(this.options.cliProductPolicy !== true || this.options.tuiProductPolicy === true
                    ? { includeDetailedUsage: true }
                    : {}),
                ...(prepared.contextUsagePromptRanges !== undefined
                    ? {
                        contextUsagePromptRanges: prepared.contextUsagePromptRanges,
                        contextUsageRequiresProviderAnchor: prepared.contextUsageRequiresProviderAnchor,
                    }
                    : {}),
                recallOutputAttemptHistory: async (attempt) => {
                    if (!input.recallOutputAttemptHistory) {
                        throw new AgentHostDependencyUnavailableError('history-retract-turn');
                    }
                    await input.recallOutputAttemptHistory(attempt);
                    input.rearmPrimaryUserMessageIdAfterOutputRecall();
                },
                onOutputRecall: (recall) => this.options.attemptRecall.recallAssistantAttempt({
                    sessionId: input.lease.sessionId,
                    turnId: input.lease.turnId,
                    ...recall,
                }),
                ...(this.options.captureToolTiming?.(input) ? { captureToolTiming: true } : {}),
                ...preemptionRunOption(preemption),
            });
        }
        finally {
            preemption?.close();
            await childBash?.close();
        }
        return {
            outcome: attachWaitingForUser(input.resolveTerminalOutcome(reconcileIntent(runnerResult)), runnerResult?.outcome?.waitingForUser === true),
            prepared,
            readTaskOutputTaskIds,
            savedPtcScripts,
            runnerResult,
            promptSuggestion: readPromptSuggestionScope(input, prepared, promptSuggestion?.capture, runnerResult?.outcome?.replyMessageId),
        };
    }
    /** Fires optional reply observers once the Host durably committed the Turn. */
    afterSuccessfulCommit(outcome) {
        this.promptSuggestions.committed(outcome);
        this.committedReplies.committed(outcome);
    }
    async settleTurn(input, settled) {
        try {
            const observation = await this.options.fileChanges.finalize({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                ...(settled.runnerResult?.outcome?.messageId
                    ? { assistantMessageId: settled.runnerResult.outcome.messageId }
                    : {}),
            });
            const committed = attachCommittedFacts(settled.outcome, observation, settled.readTaskOutputTaskIds, settled.savedPtcScripts);
            this.promptSuggestions.remember(committed, settled.promptSuggestion);
            this.committedReplies.remember(committed, input.lease, settled.runnerResult?.outcome?.replyMessageId);
            return committed;
        }
        catch (error) {
            return this.throwWithFileFailure(input, error);
        }
    }
    async throwWithFileFailure(input, error) {
        const fileFailure = await this.markFileChangesFailed(input);
        if (fileFailure !== undefined) {
            throw new AggregateError([error, fileFailure], 'Agent Turn failed and file-change failure projection also failed.');
        }
        throw error;
    }
    async prepareRunnerInput(input, eventWriter) {
        const llm = toRunnerLlmConfig(input.preparation.llm);
        const baseSystemPrompt = readPreparedSystemPrompt(input.preparation.agentConfig);
        const lightweightMode = isLightweightRootSession(input.session);
        const preparedExecution = await this.options.executionPreparation.prepare({
            execution: input,
            eventWriter,
            pluginHookCoordinator: this.pluginHooks.coordinator,
        });
        const readTaskOutputTaskIds = new Set();
        const savedPtcScripts = new Map();
        const toolResolution = preparedExecution.toolResolution;
        const admittedTools = applyProcessLocalToolResultPolicy(validateRoutedTurnTools(input.assembly.tools), this.options.cliProductPolicy === true);
        const ptc = preparePtcExecution(input.assembly.tools, admittedTools, this.options, input);
        const canConsumeNativeTaskOutput = ptc.canConsumeNativeTaskOutput;
        const standardTools = this.prepareBashTools(admittedTools, canConsumeNativeTaskOutput, this.options.nativeDelete?.() === true, input.preparation.agentShell);
        const toolContext = {
            ...toolResolution.context,
            ...pluginToolContext(input, this.pluginHooks.coordinator),
            ...userSteeringToolContext(input.control),
            // Use admitted tools, including frozen selectors and final routing. A
            // configured/MCP namesake cannot read the native background task store.
            allowBashAutoPromotion: canConsumeNativeTaskOutput,
            canConsumeBackgroundBashOutput: canConsumeNativeTaskOutput,
            canConsumeBackgroundTaskOutput: canConsumeNativeTaskOutput,
            ...ptc.context,
        };
        const caller = preparedExecution.caller;
        const standardSystemPrompt = joinPrompt(input.assembly.systemPromptPrefix, baseSystemPrompt);
        const standardContextUsagePromptRanges = readPreparedContextUsagePromptRanges(input.preparation.agentConfig, input.assembly.systemPromptPrefix, baseSystemPrompt);
        const providerContext = resolveProviderContextMode(input.session, {
            systemPrompt: standardSystemPrompt,
            tools: standardTools,
            ...(standardContextUsagePromptRanges === undefined
                ? {}
                : { contextUsagePromptRanges: standardContextUsagePromptRanges }),
        });
        const genuineUserQueryText = resolveCoordinatorGenuineUserQueryText(input, preparedExecution.genuineUserQueryText ?? input.request.genuineUserQueryText);
        // A coordinator's main conversation (spec 8, 9): a frozen prefix and a delta block.
        const { systemPrompt, tools, contextUsagePromptRanges, deltaBlocks } = await resolveTurnPrefix(input, this.options, providerContext, genuineUserQueryText);
        const ptcObservation = { ...this.options, prefixBaselines: this.ptcPrefixBaselines };
        observePtcTurnAdmission(input, ptc, ptcObservation, { systemPrompt, tools });
        observePromptSectionChange({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            systemPrompt,
            ranges: contextUsagePromptRanges,
        }, { logger: this.options.logger, metricsClient: this.options.metricsClient });
        input.onContextUsagePromptRangesResolved?.(contextUsagePromptRanges);
        const userPromptPrefix = turnUserPromptPrefix(input, preparedExecution.reminderBlocks);
        let userMessage = withGenuineQueryProvenance({
            ...preparedExecution.userMessage,
            text: joinUserPrompt(userPromptPrefix, '', '', preparedExecution.promptText ?? input.canonicalUserInput.text),
        }, genuineUserQueryText);
        const history = copyCanonicalHistoryForPiCompatibility(providerHistory(input));
        const batchMessages = prepareInitialImmediateSendBatch(input, {
            messages: preparedExecution.initialBatchMessages,
            genuineUserQueryTexts: preparedExecution.initialBatchGenuineUserQueryTexts,
        }, userMessage, userPromptPrefix);
        const beforeBatchMessages = batchMessages.slice(0, -1).map(toPiUserMessage);
        userMessage = batchMessages.at(-1);
        const canonicalMessages = [...history, ...beforeBatchMessages, toPiUserMessage(userMessage)];
        const initialHookInput = createInitialHookInput({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            signal: input.lease.signal,
            llm,
            canonicalMessages,
            systemPrompt,
            tools,
            eventWriter,
        });
        const suppressExecutionReminders = this.options.suppressExecutionReminders?.(input.session, input.preparation.agentConfig) ===
            true;
        const reminders = await prepareTurnReminders({
            options: this.options,
            background: {
                hookInput: initialHookInput,
                loadFacts: preparedExecution.loadBackgroundReminder,
                hasSuccessfulTaskOutputRead: () => readTaskOutputTaskIds.size > 0,
            },
            lightweightMode,
            suppressed: suppressExecutionReminders,
            executionDeadlineAtMs: input.request.executionDeadlineAtMs,
        });
        // Request-only; its initial-phase hook runs after every placing reminder (see
        // ToolSearchContextHooks); the shared-prefix checkpoint repeats it with the PTC
        // reminder copy (`projectTurnRequestContext`). Lightweight: no tools, no catalog.
        const toolSearchContext = toolSearchContextHooks(createToolSearchContextHook({
            tools: lightweightMode ? [] : input.assembly.tools,
            sessionId: input.lease.sessionId,
            logger: this.options.logger,
            canAppend: this.options.canAppendExecutionBudgetReminder,
        }));
        const beforeLlmCallHooks = await this.resolveBeforeLlmCallHooks(input, withPtcCompactionReminder(createPtcTurnCompactionReminder(input, this.options), 
        // Tool Search's iteration hook only rewrites the request and goes first.
        [
            toolSearchContext.iteration,
            createSkillCatalogContextHook({ sessionId: input.lease.sessionId }),
            ...reminders.hooks,
        ]), suppressExecutionReminders, toolSearchContext.initial);
        validateResolvedInput({
            input,
            llm,
            systemPrompt,
            userMessage,
            tools: toolResolution,
            toolContext,
            beforeLlmCallHooks,
        });
        return {
            llm,
            systemPrompt,
            userMessage,
            history,
            beforeUserMessages: [
                ...reminders.beforeUserMessages,
                // Right before the Turn's first user or event message (spec 9.1).
                ...deltaBlocks,
                ...beforeBatchMessages,
            ],
            tools,
            ...(ptc.ptcTools ? { ptcTools: ptc.ptcTools } : {}),
            toolResolution,
            toolContext,
            beforeLlmCallHooks,
            // The windows and notices the Turn planned take effect once a request is answered.
            afterLlmCallHooks: [
                createToolSearchResponseHook({ sessionId: input.lease.sessionId }),
                createSkillCatalogResponseHook({ sessionId: input.lease.sessionId }),
            ],
            caller,
            ...agentKindField(preparedExecution.agentKind),
            ...wakeField(preparedExecution.wake),
            ...lightweightToolCallFallback(lightweightMode),
            ...(contextUsagePromptRanges !== undefined
                ? {
                    contextUsagePromptRanges,
                    contextUsageRequiresProviderAnchor: input.preparation.llm.managedProvider !== true,
                }
                : {}),
            readTaskOutputTaskIds,
            savedPtcScripts,
            ptcObserver: ptc.context.ptcObserver,
            ptcFactCollector: ptc.ptcFactCollector,
            prepareSteering: preparedExecution.prepareSteering ?? preparePlainSteering,
            stateLayerApplied: deltaBlocks.length > 0,
        };
    }
    /**
     * Once history holds the Turn's user message it also holds whatever the
     * assembly rendered into its prefix, so a Skill preload may keep the receipts
     * it wrote. A Turn stopped or failed before this commit never carried the
     * bodies. A continuation resumes the loop without a message and settles
     * nothing, because it never preloaded anything either.
     */
    reportUserMessageSubmitted(input, userMessage, committedMessages) {
        if (input.request.executionMode === 'continuation')
            return;
        if (!committedMessages.some((message) => isTurnUserMessage(message, userMessage)))
            return;
        this.options.onUserMessageSubmitted?.(input.lease);
    }
    async resolveBeforeLlmCallHooks(input, afterCompactionHooks, suppressExecutionReminders, lastHook) {
        return [
            ...((await this.options.resolveBeforeLlmCallHooks?.(input)) ?? []),
            ...(input.contextCompactionHook
                ? [
                    withPluginAutomaticCompactionLifecycle(input.contextCompactionHook, input, this.pluginHooks.coordinator),
                ]
                : []),
            ...afterCompactionHooks,
            ...(this.options.afterCompactionBeforeLlmCallHooks ?? []),
            ...(suppressExecutionReminders ? [] : (this.options.genericExecutionReminderHooks ?? [])),
            ...(input.assembly.reminders.some(({ reminder }) => reminder.requestOnly)
                ? [
                    createRequestOnlyReminderHook(renderAgentRuntimeReminders(input.assembly.reminders.filter(({ reminder }) => reminder.requestOnly))),
                ]
                : []),
            ...(lastHook ? [lastHook] : []),
        ];
    }
    async beginFileChanges(input) {
        try {
            await this.options.fileChanges.begin({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                agentName: input.agent.agentName,
                workspaceDir: input.session.workspaceDir,
            });
        }
        catch (error) {
            this.reportBestEffortFailure(input.lease.sessionId, `local_turn_diff_begin_failed:${describeUnknownError(error)}`);
        }
    }
    async markFileChangesFailed(input) {
        try {
            await this.options.fileChanges.markFailed({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
            });
            return undefined;
        }
        catch (error) {
            this.reportBestEffortFailure(input.lease.sessionId, `local_turn_diff_failed:${describeUnknownError(error)}`);
            return error;
        }
    }
    reportBestEffortFailure(sessionId, message) {
        try {
            this.options.reportFailure?.(sessionId, message);
        }
        catch {
            // Diagnostic reporting cannot replace the owning Turn failure.
        }
    }
    projectEvalSessionFields(session, sessionId) {
        try {
            return {
                agentName: session.agentName === 'main' ? 'mavis' : session.agentName,
                sessionKind: session.sessionKind,
                sessionType: session.sessionType,
                parentSessionId: session.parentSessionId,
                sessionOrigin: session.sessionOrigin,
                sessionCreatedAtMs: session.createdAtMs,
                isDefaultWorkspace: session.isDefaultWorkspace,
                sessionPurpose: session.purpose,
            };
        }
        catch (error) {
            this.reportBestEffortFailure(sessionId, `local_eval_session_fields_failed:${error instanceof Error ? error.name : typeof error}`);
            return undefined;
        }
    }
}
/**
 * Assembly plus host LLM-call hooks, kept in their own function so `mergeHooks`
 * stays under the complexity limit. Both arrays keep the order they had inline.
 */
function mergeLlmCallHooks(assemblyHooks, hostBeforeLlmCallHooks, hostAfterLlmCallHooks) {
    return {
        beforeLlmCallHook: [...(assemblyHooks.beforeLlmCallHook ?? []), ...hostBeforeLlmCallHooks],
        // Host observers first: a later hook that rejects the response cannot hide that it arrived.
        afterLlmCallHook: [...hostAfterLlmCallHooks, ...(assemblyHooks.afterLlmCallHook ?? [])],
    };
}
function mergeHooks(options) {
    const { input, toolResolution, pendingToolResultTailClaims, hostBeforeLlmCallHooks, hostAfterLlmCallHooks, readTaskOutputTaskIds, savedPtcScripts, ptcObserver, terminalTaskOutputReadIds, toolsDisabled, toolSafetyGuard, toolPolicyGuard, finalizeToolResultForHistory, ptcFactCollector, reportCommittedHistory, } = options;
    // The same trusted declaration the tool context carries, so a coordinator's
    // legacy mavis call reads one refusal everywhere.
    const coordination = readTrustedAgentCoordination(input.preparation.agentConfig);
    const toolHooks = createControlledToolHooks({
        input,
        pluginHookCoordinator: options.pluginHookCoordinator,
        permissionGuard: toolResolution.permissionGuard,
        ...(coordination ? { coordination } : {}),
        pendingToolResultTailClaims,
        readTaskOutputTaskIds,
        savedPtcScripts,
        ptcObserver,
        terminalTaskOutputReadIds,
        toolsDisabled,
        toolSafetyGuard,
        toolPolicyGuard,
        finalizeToolResultForHistory,
        deferredExecutionReason: options.deferredExecutionReason,
        ...(ptcFactCollector ? { ptcFactCollector } : {}),
        toolContentReview: options.toolContentReview,
    });
    return {
        ...input.assembly.hooks,
        ...toolHooks,
        ...mergeLlmCallHooks(input.assembly.hooks, hostBeforeLlmCallHooks, hostAfterLlmCallHooks),
        onHistoryChangedHook: [
            async (change) => {
                await input.onHistoryChanged(change);
                reportCommittedHistory(change.messages);
                await input.pluginHookTranscriptWriter?.apply(change);
                await ackCommittedToolResultTailClaims(change.messages, pendingToolResultTailClaims, input);
            },
            ...(input.assembly.hooks.onHistoryChangedHook ?? []),
        ],
        onStepEndHook: input.assembly.hooks.onStepEndHook ?? [],
        ...(input.mainRequestObserver
            ? {
                onLlmCallPreparedHook: [
                    ...(input.assembly.hooks.onLlmCallPreparedHook ?? []),
                    input.mainRequestObserver,
                ],
            }
            : {}),
        ...(input.turnFailureHook
            ? {
                turnFailureHook: [...(input.assembly.hooks.turnFailureHook ?? []), input.turnFailureHook],
            }
            : {}),
    };
}
function isTurnUserMessage(message, userMessage) {
    if (message.role !== 'user')
        return false;
    const [first] = Array.isArray(message.content) ? message.content : [];
    return first?.type === 'text' && first.text === userMessage.text;
}
function toRunnerLlmConfig(prepared) {
    const { maxRequestBodyBytes, ...preparedLlm } = prepared;
    return {
        ...preparedLlm,
        ...(maxRequestBodyBytes === undefined ? {} : { maxSerializedInputBytes: maxRequestBodyBytes }),
    };
}
/** The Turn registry the event bridge fills for post-commit observers; absent in older callers. */
function toolCallContentOption(input) {
    return input.toolCallContent ? { toolCallContent: input.toolCallContent } : {};
}
/**
 * A continuation run's event ids carry its lease, so they never repeat an
 * earlier run of the turn. Only a run that can yield needs it: its Host (cloud)
 * runs one turn over several runs under the same turn id. `isYieldStopped` is
 * wired only for such a run (yield armed, assistant ids aligned). Desktop runs
 * never yield and continue a turn in a turn of its own, whose id already keeps
 * the event ids apart, so they stay as they were.
 */
function continuationLeaseOf(input) {
    return input.request.executionMode === 'continuation' && input.isYieldStopped
        ? { continuationLeaseId: input.lease.leaseId }
        : {};
}
//# sourceMappingURL=executor.js.map