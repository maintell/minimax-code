import { createContinuationControl, resolveChildBashSteeringContext, prepareInitialImmediateSendBatch, withGenuineQueryProvenance, } from './user-input-control.js';
import { toPiUserMessage, } from '@mavis/agent-core/pi-turn-runner';
import {} from '@mavis/agent-core/tools';
import { prepareBashTurnTools } from '../assembly/local-turn-tool-catalog.js';
import { createPluginAgentRoster } from '../assembly/turn-capability-lifecycle.js';
import { buildCompletedTerminalStatusEvent, buildRuntimeWarningEvent, } from '@mavis/agent-core/event-bridge';
import { beginLocalPluginHookTurn, createLocalPluginHookEventReporter, emitLocalPluginHookWarnings, localPluginHookCoordinator as pluginHookCoordinator, } from '../assembly/local-turn-plugin-hooks.js';
import { copyCanonicalHistoryForPiCompatibility } from '../history/canonical-history-validation.js';
import { assertLocalOutputFormatCapability, buildTurnPayloadTransforms, } from '../assembly/local-turn-payload-transform.js';
import { AgentHostDependencyUnavailableError, assertAgentHostCapabilityAvailable, } from '../empty-dependencies.js';
import { createLocalTurnEventWriter, } from '../events/runtime-event-writer.js';
import { AgentEventAssociationError } from '../local-agent-host.js';
import { inputReviewRunnerOptions } from '../runner/policy/input-review-runner-options.js';
import { applyProcessLocalToolResultPolicy } from '../runner/policy/process-local-tool-result-policy.js';
import { joinPrompt, joinUserPrompt, isLightweightRootSession, LIGHTWEIGHT_TOOL_CALL_FALLBACK, readPreparedContextUsagePromptRanges, readPreparedSystemPrompt, renderAgentRuntimeReminders, resolveProviderContextMode, } from './prompt.js';
import { createAgentHostPluginHookTranscript, } from '../tools/index.js';
import { withPluginAutomaticCompactionLifecycle } from './plugin-hook-compaction-lifecycle.js';
import { createControlledToolHooks } from './plugin-hook-tool-lifecycle.js';
import { createExecutionBudgetReminder } from '../runner/execution-budget-reminder.js';
import { withExecutionObservability } from './execution-observability.js';
import { ackCommittedToolResultTailClaims, attachCommittedFacts, attachWaitingForUser, continuationRunMode, contentReviewOptions, hostOutputTokenCap, providerHistory, resolveLlmRetryOptions, } from './turn-execution-policy.js';
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
    constructor(options) {
        this.options = options;
        validateOptions(options);
    }
    async execute(input) {
        let unboundPluginHookTranscriptCleanup;
        try {
            const eventWriter = createLocalTurnEventWriter(input, this.options.projectRuntimeEvent);
            const pluginHookEventReporter = createLocalPluginHookEventReporter({
                writer: eventWriter,
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
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
            const admission = await beginLocalPluginHookTurn(contextualInput, {
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
            pluginHookCoordinator.resumeIdleCountdown(input.lease.sessionId);
        }
    }
    async commitPluginHookAdmission(input, transaction, sessionOwnershipClaim) {
        if (!sessionOwnershipClaim) {
            await transaction.commit();
            return;
        }
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
            const writer = await createAgentHostPluginHookTranscript({
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
        const terminalTaskOutputReadIds = new Set();
        const continuation = createContinuationControl(input, prepared.prepareSteering, this.options.onSteeringConsumed);
        const toolSafetyGuard = this.options.createTurnToolSafetyGuard?.();
        const payloadTransforms = buildTurnPayloadTransforms(input, outputContract, this.options);
        const childBash = this.options.createChildBashLifecycle?.({
            session: input.session,
            turnId: input.lease.turnId,
            signal: input.lease.signal,
        });
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
                ...(prepared.beforeUserMessages.length > 0
                    ? { beforeUserMessages: prepared.beforeUserMessages }
                    : {}),
                outputRevisionInstruction: input.preparation.outputRevisionInstruction,
                ...continuationRunMode(input),
                ...inputReviewRunnerOptions(input, this.options.onInputReviewResolved),
                ...contentReviewOptions(input, this.options),
                ...(this.options.tuiProductPolicy === true ? { deferInputReviewResolution: true } : {}),
                llm: {
                    ...prepared.llm,
                    ...hostOutputTokenCap(this.options.outputTokenCap, input),
                    ...payloadTransforms,
                },
                eventWriter,
                eventIdGenerator: input.pluginHookEventReporter?.nextEventId,
                runtimeSeqGenerator: input.pluginHookEventReporter?.nextRuntimeSeq,
                history: prepared.history,
                signal: input.lease.signal,
                tools: prepared.tools,
                disableBuiltinToolFallback: prepared.toolResolution.disableBuiltinToolFallback,
                toolContext: prepared.toolContext,
                hooks: withExecutionObservability(mergeHooks({
                    input,
                    toolResolution: prepared.toolResolution,
                    pendingToolResultTailClaims,
                    hostBeforeLlmCallHooks: prepared.beforeLlmCallHooks,
                    readTaskOutputTaskIds,
                    terminalTaskOutputReadIds,
                    toolsDisabled: this.options.disableTools === true,
                    toolSafetyGuard,
                    toolPolicyGuard: this.options.toolPolicyGuard,
                    finalizeToolResultForHistory: this.options.finalizeToolResultForHistory,
                }), input.request.provenance.sourceContext?.executionDiagnostics === true),
                caller: prepared.caller,
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
                            wait: context?.boundary === 'exit' &&
                                messages.length === 0 &&
                                !continuation.shouldStopAfterSteering?.(),
                            readTaskIds: terminalTaskOutputReadIds,
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
                llmRetry: await resolveLlmRetryOptions(input, this.options),
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
                    attempt: recall.attempt,
                    messageIds: recall.messageIds,
                }),
                ...(this.options.captureToolTiming?.(input) ? { captureToolTiming: true } : {}),
            });
        }
        finally {
            await childBash?.close();
        }
        return {
            outcome: attachWaitingForUser(input.resolveTerminalOutcome(reconcileIntent(runnerResult)), runnerResult?.outcome?.waitingForUser === true),
            prepared,
            readTaskOutputTaskIds,
            runnerResult,
        };
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
            return attachCommittedFacts(settled.outcome, observation, settled.readTaskOutputTaskIds);
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
        });
        const readTaskOutputTaskIds = new Set();
        const toolResolution = preparedExecution.toolResolution;
        const admittedTools = applyProcessLocalToolResultPolicy(validateRoutedTurnTools(input.assembly.tools), this.options.cliProductPolicy === true);
        const canConsumeNativeTaskOutput = admittedTools.some((tool) => tool.def.name === 'task_output' && (tool.source === undefined || tool.source === 'builtin'));
        const standardTools = prepareBashTurnTools(admittedTools, canConsumeNativeTaskOutput, this.options.nativeDelete?.() === true, input.preparation.agentShell);
        const toolContext = {
            ...toolResolution.context,
            ...pluginToolContext(input),
            // Use admitted tools, including frozen selectors and final routing. A
            // configured/MCP namesake cannot read the native background task store.
            allowBashAutoPromotion: canConsumeNativeTaskOutput,
            canConsumeBackgroundBashOutput: canConsumeNativeTaskOutput,
            canConsumeBackgroundTaskOutput: canConsumeNativeTaskOutput,
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
        const { systemPrompt, tools, contextUsagePromptRanges } = providerContext;
        input.onContextUsagePromptRangesResolved?.(contextUsagePromptRanges);
        const userPromptPrefix = joinUserPrompt(input.assembly.userPromptPrefix, renderAgentRuntimeReminders(input.assembly.reminders), joinPrompt(preparedExecution.reminderBlocks.join('\n\n'), input.pluginHookContext
            ? `<plugin-hook-context>\n${input.pluginHookContext}\n</plugin-hook-context>`
            : ''), '');
        let userMessage = withGenuineQueryProvenance({
            ...preparedExecution.userMessage,
            text: joinUserPrompt(userPromptPrefix, '', '', preparedExecution.promptText ?? input.canonicalUserInput.text),
        }, preparedExecution.genuineUserQueryText ?? input.request.genuineUserQueryText);
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
        const backgroundReminder = await this.options.backgroundCadenceReminder?.prepare({
            hookInput: initialHookInput,
            loadFacts: preparedExecution.loadBackgroundReminder,
            hasSuccessfulTaskOutputRead: () => readTaskOutputTaskIds.size > 0,
        });
        const beforeLlmCallHooks = await this.resolveBeforeLlmCallHooks(input, afterCompactionReminderHooks(createExecutionBudgetReminder(input.request.executionDeadlineAtMs, this.options.nowMs, this.options.canAppendExecutionBudgetReminder, this.options.logger), backgroundReminder?.hook));
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
                ...(backgroundReminder?.beforeUserMessages ?? []),
                ...beforeBatchMessages,
            ],
            tools,
            toolResolution,
            toolContext,
            beforeLlmCallHooks,
            caller,
            ...(lightweightMode
                ? {
                    unexpectedToolCallFallback: LIGHTWEIGHT_TOOL_CALL_FALLBACK,
                }
                : {}),
            ...(contextUsagePromptRanges !== undefined
                ? {
                    contextUsagePromptRanges,
                    contextUsageRequiresProviderAnchor: input.preparation.llm.managedProvider !== true,
                }
                : {}),
            readTaskOutputTaskIds,
            prepareSteering: preparedExecution.prepareSteering ?? preparePlainSteering,
        };
    }
    async resolveBeforeLlmCallHooks(input, afterCompactionHooks = []) {
        return [
            ...((await this.options.resolveBeforeLlmCallHooks?.(input)) ?? []),
            ...(input.contextCompactionHook
                ? [withPluginAutomaticCompactionLifecycle(input.contextCompactionHook, input)]
                : []),
            ...afterCompactionHooks,
            ...(this.options.afterCompactionBeforeLlmCallHooks ?? []),
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
function pluginToolContext(input) {
    return {
        ...(input.pluginHooks?.length
            ? { pluginSubagentLifecycle: createPluginSubagentLifecycle(input) }
            : {}),
        ...(input.desktopCapabilities?.agents?.length
            ? { pluginAgents: createPluginAgentRoster(input.desktopCapabilities.agents) }
            : {}),
    };
}
function createPluginSubagentLifecycle(input) {
    return {
        start: (child, signal) => startPluginSubagent(input, child, signal),
        cancel: (childSessionId) => pluginHookCoordinator.cancelSubagent(childSessionId),
    };
}
async function startPluginSubagent(input, child, signal) {
    const decision = await pluginHookCoordinator.startSubagent(buildPluginSubagentRegistration(input, child), signal);
    await emitLocalPluginHookWarnings({
        reporter: input.pluginHookEventReporter,
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        event: 'SubagentStart',
        decision,
    });
    if (decision.continue === false) {
        throw new Error(decision.stopReason ?? 'Subagent stopped by Plugin Hook.');
    }
    return decision.additionalContext;
}
function buildPluginSubagentRegistration(input, child) {
    const runtimeContext = input.pluginHookRuntimeContext;
    return {
        handlers: input.pluginHooks ?? [],
        parentSessionId: input.lease.sessionId,
        parentTurnId: input.lease.turnId,
        parentPromptId: runtimeContext?.promptId ?? input.lease.turnId,
        childSessionId: child.childSessionId,
        childTurnId: child.childTurnId,
        cwd: input.session.workspaceDir,
        ...(runtimeContext?.transcriptPath !== undefined
            ? { parentTranscriptPath: runtimeContext.transcriptPath }
            : {}),
        ...(runtimeContext?.codexTranscriptPath !== undefined
            ? { parentCodexTranscriptPath: runtimeContext.codexTranscriptPath }
            : {}),
        ...(runtimeContext?.model ? { model: runtimeContext.model } : {}),
        ...(runtimeContext?.permissionMode ? { permissionMode: runtimeContext.permissionMode } : {}),
        ...(runtimeContext?.effort ? { effort: runtimeContext.effort } : {}),
        agentId: resolvePluginSubagentAgentId(child),
        agentType: child.agentType,
        ...(child.agentTranscriptPath ? { agentTranscriptPath: child.agentTranscriptPath } : {}),
        ...(child.agentCodexTranscriptPath
            ? { agentCodexTranscriptPath: child.agentCodexTranscriptPath }
            : {}),
    };
}
function resolvePluginHookSessionOwnershipClaim(prepareOwnership, leaseId) {
    return prepareOwnership ? leaseId : undefined;
}
function resolvePluginSubagentAgentId(child) {
    return child.agentId ?? child.childSessionId;
}
async function cleanupPluginHookTranscriptBestEffort(cleanup) {
    if (!cleanup)
        return;
    try {
        await cleanup();
    }
    catch {
        // Ownership preparation failed before the transcript could be attached.
    }
}
function pluginHookTranscriptCleanup(writer) {
    return writer ? () => writer.cleanup() : undefined;
}
/**
 * `runBeforeLLM` accumulates `appendMessage` decisions, so later hooks still
 * run. The budget reminder stays before the background cadence reminder so
 * its request-only marker precedes the durable background marker and the
 * reminder admission sees the request before that marker is registered.
 */
function afterCompactionReminderHooks(budgetReminder, backgroundReminder) {
    return [
        ...(budgetReminder ? [budgetReminder] : []),
        ...(backgroundReminder ? [backgroundReminder] : []),
    ];
}
/**
 * Maps the neutral runner's optional reconcile signal onto a host reconcile
 * intent. The concrete detection lives in the v2 native runner adapter; the
 * host only normalizes the approved partial content to a string.
 */
function reconcileIntent(result) {
    const signal = result?.reconcile;
    if (!signal)
        return undefined;
    switch (signal.kind) {
        case 'output-recall':
            return { kind: 'output-recall', source: signal.source, variant: signal.variant };
        case 'network-reconcile':
            return { kind: 'network-reconcile', approvedContent: signal.approvedContent ?? '' };
        case 'abort-reconcile':
            return { kind: 'abort-reconcile', approvedContent: signal.approvedContent ?? '' };
        default:
            return undefined;
    }
}
function mergeHooks(options) {
    const { input, toolResolution, pendingToolResultTailClaims, hostBeforeLlmCallHooks, readTaskOutputTaskIds, terminalTaskOutputReadIds, toolsDisabled, toolSafetyGuard, toolPolicyGuard, finalizeToolResultForHistory, } = options;
    const toolHooks = createControlledToolHooks({
        input,
        permissionGuard: toolResolution.permissionGuard,
        pendingToolResultTailClaims,
        readTaskOutputTaskIds,
        terminalTaskOutputReadIds,
        toolsDisabled,
        toolSafetyGuard,
        toolPolicyGuard,
        finalizeToolResultForHistory,
    });
    return {
        ...input.assembly.hooks,
        ...toolHooks,
        beforeLlmCallHook: [
            ...(input.assembly.hooks.beforeLlmCallHook ?? []),
            ...hostBeforeLlmCallHooks,
        ],
        onHistoryChangedHook: [
            async (change) => {
                await input.onHistoryChanged(change);
                await input.pluginHookTranscriptWriter?.apply(change);
                ackCommittedToolResultTailClaims(change.messages, pendingToolResultTailClaims, input);
            },
            ...(input.assembly.hooks.onHistoryChangedHook ?? []),
        ],
        onStepEndHook: input.assembly.hooks.onStepEndHook ?? [],
    };
}
function toRunnerLlmConfig(prepared) {
    const { maxRequestBodyBytes, ...preparedLlm } = prepared;
    return {
        ...preparedLlm,
        ...(maxRequestBodyBytes === undefined ? {} : { maxSerializedInputBytes: maxRequestBodyBytes }),
    };
}
function validateRoutedTurnTools(tools) {
    return tools.reduce((catalog, tool) => {
        if (catalog.some((candidate) => candidate.def.name === tool.def.name)) {
            throw new Error(`Duplicate tool name '${tool.def.name}' after v2 tool routing.`);
        }
        return [...catalog, tool];
    }, []);
}
function validateOptions(options) {
    assertAgentHostCapabilityAvailable('local-runtime-turn-runner', typeof options.runtime?.runTurn === 'function');
    assertAgentHostCapabilityAvailable('turn-execution-preparation', typeof options.executionPreparation?.prepare === 'function');
    assertAgentHostCapabilityAvailable('turn-file-change-lifecycle', [
        options.fileChanges?.begin,
        options.fileChanges?.finalize,
        options.fileChanges?.markFailed,
    ].every((operation) => typeof operation === 'function'));
    if (Boolean(options.preparePluginHookSessionOwnership) !==
        Boolean(options.activatePluginHookSessionOwnership)) {
        throw new TypeError('Plugin Hook Session ownership preparation and activation must be paired.');
    }
}
function validateResolvedInput(resolved) {
    validateResolvedPrompt(resolved);
    validateResolvedTools(resolved);
    validateResolvedBeforeLlmCallHooks(resolved);
}
function validateResolvedBeforeLlmCallHooks(resolved) {
    if (!Array.isArray(resolved.beforeLlmCallHooks) ||
        resolved.beforeLlmCallHooks.some((hook) => typeof hook !== 'function')) {
        throw new TypeError('Resolved host beforeLlmCall hooks are invalid.');
    }
}
function validateResolvedPrompt(resolved) {
    if (!resolved.llm?.model)
        throw new TypeError('Resolved LLMModelConfig.model is required.');
    if (typeof resolved.systemPrompt !== 'string') {
        throw new TypeError('Resolved system prompt is invalid.');
    }
    if (typeof resolved.userMessage?.text !== 'string') {
        throw new TypeError('Prepared user message is invalid.');
    }
    if (resolved.userMessage.attachments !== undefined &&
        !Array.isArray(resolved.userMessage.attachments)) {
        throw new TypeError('Prepared user message attachments are invalid.');
    }
}
function validateResolvedTools(resolved) {
    if (!resolved.tools?.context || typeof resolved.tools.permissionGuard !== 'function') {
        throw new TypeError('Resolved host tool and permission context is invalid.');
    }
    if (resolved.toolContext.sessionId !== resolved.input.lease.sessionId) {
        throw new AgentEventAssociationError('sessionId', resolved.input.lease.sessionId, resolved.toolContext.sessionId);
    }
    if (resolved.toolContext.turnId !== resolved.input.lease.turnId) {
        throw new AgentEventAssociationError('turnId', resolved.input.lease.turnId, resolved.toolContext.turnId);
    }
}
function preparePlainSteering(input) {
    return Promise.resolve({
        userMessage: { text: input.message.text },
        genuineUserQueryText: input.genuineUserQueryText,
    });
}
function createInitialHookInput(input) {
    const { llm } = input;
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        phase: 'initial',
        messages: input.canonicalMessages,
        canonicalMessages: input.canonicalMessages,
        model: llm.model,
        ...(llm.apiKey === undefined ? {} : { apiKey: llm.apiKey }),
        ...(llm.headers === undefined ? {} : { headers: llm.headers }),
        ...(llm.maxTokens === undefined ? {} : { maxTokens: llm.maxTokens }),
        ...(llm.maxSerializedInputBytes === undefined
            ? {}
            : { maxSerializedInputBytes: llm.maxSerializedInputBytes }),
        systemPrompt: input.systemPrompt,
        tools: input.tools.map((tool) => ({
            name: tool.def.name,
            description: tool.def.description,
            parameters: tool.def.schema,
        })),
        thinkingLevel: llm.thinkingLevel ?? 'off',
        signal: input.signal,
        eventWriter: input.eventWriter,
    };
}
function describeUnknownError(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    }
    catch {
        return 'unknown error';
    }
}
//# sourceMappingURL=executor.js.map