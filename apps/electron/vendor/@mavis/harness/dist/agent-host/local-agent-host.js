import { TurnToolCallContent } from '@mavis/agent-core/event-bridge';
import { pluginHookEffort } from '@mavis/plugin-hooks';
import { AgentHostTurnLeaseError, AgentHostTurnSequenceError, captureAcceptedTurnLease, readUnknownProperty, } from './accepted-lease.js';
import { captureAgentHostExecutionRequest, isUserAuthoredTurnSource, } from './canonical-user-input.js';
import { AgentHostCompactionExecutor, AgentHostCompactionLeaseError, AgentCompactionCloseError, AgentCompactionAssociationError, AgentCompactionSnapshotError, captureAcceptedCompactionInput, } from './compaction/agent-host-compaction-executor.js';
import { ContextCompactionAttemptFactory, createAutomaticContextCompactionHook, } from './compaction/context-compaction.js';
import { resolveCheckpointRequestShape } from './compaction/checkpoint-request-shape.js';
import { beginSegmentCompactionTurn, endSegmentTurn, prepareSegmentTurn, resetContextOrSkip, segmentCompactionRoute, segmentMainRequestObserver, segmentTurnFailureHook, settleSegmentTurn, } from './compaction/segment-turn.js';
import { assertAgentHostCompactionDependenciesReady, assertAgentHostDependenciesReady, } from './empty-dependencies.js';
import { buildHostFailedEvent } from './events/host-failed-event.js';
import { AgentHostCommittedHistoryWriter } from './history/committed-history-writer.js';
import { createBackgroundTaskReadSettlement } from './history/background/task-read-settlement.js';
import { AgentHistoryOperationIdentityError } from './history/history-operation-replay.js';
import { AgentTerminalConfirmationError, TurnCommitPipeline, commitHostFailedTerminal, } from './events/turn-commit-pipeline.js';
import { AgentHostSessionReadError } from './preparation/session-read.js';
import { AgentEventAssociationError, AgentExecutionSnapshotNotFoundError, TurnPreflight, observeAgentTurnSetupStage, } from './preparation/turn-preflight.js';
import { exactPluginMcpToolOwners, pluginMcpRuleSubjectsInput, } from './assembly/local-turn-plugin-capabilities.js';
import { LocalPluginHooks } from './assembly/local-turn-plugin-hooks.js';
import { preemptionObserverOption } from './execution/user-steering-preemption.js';
import { continuationHintOf } from './turn-yield/continuation-hint.js';
import { continuationRunMode } from './execution/turn-execution-policy.js';
import { resumeAssistantMessageIdOf } from './history/canonical-user-message-identities.js';
import { MAX_LOGGED_AGENT_HOST_FAILURES, bindTurnYield, capture, captureSync, collectTurnEndHandlerFailures, createAgentEventContext, createBaseAgentEventContext, describeAgentHostFailure, failedOutcomeFailures, flattenFailure, runTurnStartHandlers, scopeTurnControl, settleCapturedExecution, throwFailures, turnTimingField, uniqueTaskIds, } from './local-agent-host-helpers.js';
export class AgentEventIdentityError extends Error {
    name = 'AgentEventIdentityError';
    constructor(kind) {
        super(`Cannot derive a stable identity for ${kind}.`);
    }
}
class AgentHostYieldedRunError extends Error {
    name = 'AgentHostYieldedRunError';
    constructor() {
        super('AgentHost run yielded; a yieldable run must be started with runYieldable.');
    }
}
export { AgentHostTurnLeaseError, AgentHostTurnSequenceError, AgentEventAssociationError, AgentExecutionSnapshotNotFoundError, AgentCompactionAssociationError, AgentCompactionCloseError, AgentHistoryOperationIdentityError, AgentCompactionSnapshotError, AgentHostCompactionLeaseError, AgentHostSessionReadError, AgentTerminalConfirmationError, };
/** Ordered, fail-closed adapter between Turn ownership and the Agent loop. */
/**
 * The committed-history writer of one AgentHost: the Host ports it reads plus the
 * two compaction effects it forwards. Built here so the constructor stays a
 * wiring list rather than a branch per optional port.
 */
function committedHistoryWriter(dependencies) {
    return new AgentHostCommittedHistoryWriter({
        history: dependencies.history,
        events: dependencies.events,
        ...(dependencies.historyFailure ? { historyFailure: dependencies.historyFailure } : {}),
        ...(dependencies.compaction ? { compaction: dependencies.compaction } : {}),
        ...(dependencies.usage ? { usage: dependencies.usage } : {}),
        ptcPrefixBaselines: dependencies.ptcPrefixBaselines,
        // The committed-compaction callback the composition root owns: the
        // managed-Skill receipt clear.
        ...(dependencies.onCompactionCommitted
            ? { onCompactionCommitted: dependencies.onCompactionCommitted }
            : {}),
    });
}
export class LocalAgentHost {
    dependencies;
    committedHistory;
    compactionAttempts;
    compactionExecutor;
    preflight;
    pluginHooks;
    turnYield;
    /**
     * A host rebuilt per run must share one `compactionAttempts` factory so
     * attempt ids stay unique. The committed-history writer also keeps a replay
     * registry, keyed by `[sessionId, operationId]`; every operation id embeds
     * the lease turnId and a turnId is run once, so a fresh registry per run
     * loses no replay a later run could hit.
     *
     * `turnYield` makes the run yieldable; it is per run, like the host the
     * engine builds for it.
     */
    constructor(dependencies, options = {}) {
        this.dependencies = dependencies;
        this.compactionAttempts = options.compactionAttempts ?? new ContextCompactionAttemptFactory();
        this.turnYield = options.turnYield;
        this.pluginHooks = dependencies.pluginHooks ?? new LocalPluginHooks();
        this.committedHistory = committedHistoryWriter(dependencies);
        this.compactionExecutor = new AgentHostCompactionExecutor({
            agents: dependencies.agents,
            assembleModelContext: (context, desktopCapabilities) => dependencies.agentRuntimes.normal.assembleModelContext(context, desktopCapabilities),
            sessions: dependencies.sessions,
            history: dependencies.history,
            ...(dependencies.buildRequestPayloadTransform
                ? { buildRequestPayloadTransform: dependencies.buildRequestPayloadTransform }
                : {}),
            ...(dependencies.resolvePluginHookRuntimeContext
                ? { resolvePluginHookRuntimeContext: dependencies.resolvePluginHookRuntimeContext }
                : {}),
            pluginHooks: this.pluginHooks,
            ...(dependencies.compaction ? { compaction: dependencies.compaction } : {}),
            ...(dependencies.logger ? { logger: dependencies.logger } : {}),
            assertReady: () => assertAgentHostCompactionDependenciesReady(dependencies),
        }, this.committedHistory, this.compactionAttempts);
        this.preflight = new TurnPreflight(dependencies);
    }
    notifyTurnStarted(context) {
        try {
            // A new Turn supersedes any suggestion still generating for this Session.
            this.dependencies.promptSuggestion?.turnStarted(context.sessionId);
        }
        catch {
            /* An optional suggestion can never fail a Turn. */
        }
        try {
            this.dependencies.turnTiming?.hostStarted(context);
        }
        catch {
            /* Latency checkpoints can never fail a Turn. */
        }
    }
    async run(input) {
        const outcome = await this.runYieldable(input);
        if (outcome.status === 'yielded')
            throw new AgentHostYieldedRunError();
        return outcome;
    }
    /**
     * Runs one Turn and, with `turnYield`, may return a yielded outcome; a
     * settled outcome then carries `continuationHint`.
     */
    async runYieldable(input) {
        const hostStartedAtMs = Date.now();
        const lease = captureAcceptedTurnLease(readUnknownProperty(input, 'lease'));
        const control = scopeTurnControl(this.dependencies, lease);
        let context = createBaseAgentEventContext({ lease });
        let acceptedInput;
        const setupLogContext = {
            sessionId: lease.sessionId,
            turnId: lease.turnId,
            executionMode: 'activate',
        };
        let capabilityLease;
        let configHooks = [];
        let segmentTurn;
        try {
            let preflight;
            try {
                const request = captureAgentHostExecutionRequest(readUnknownProperty(input, 'request'));
                const beforeCapabilityCapture = input.beforeCapabilityCapture;
                acceptedInput = Object.freeze({
                    lease,
                    request,
                    ...(beforeCapabilityCapture ? { beforeCapabilityCapture } : {}),
                });
                context = createAgentEventContext(acceptedInput);
                assertAgentHostDependenciesReady(this.dependencies);
                this.notifyTurnStarted(context);
                setupLogContext.executionMode = acceptedInput.request.executionMode ?? 'activate';
                // Segment profile commit point (spec 11.5): before this Turn reads its history.
                segmentTurn = await beginSegmentCompactionTurn({
                    compaction: this.dependencies.compaction,
                    committedHistory: this.committedHistory,
                    attempts: this.compactionAttempts,
                    context,
                    leaseId: acceptedInput.lease.leaseId,
                    request: acceptedInput.request,
                });
                const turnCapabilities = this.dependencies.turnCapabilities;
                capabilityLease = turnCapabilities
                    ? await observeAgentTurnSetupStage(this.dependencies.logger, setupLogContext, 'capability_acquisition', () => turnCapabilities.acquire({
                        sessionId: acceptedInput.lease.sessionId,
                        turnId: acceptedInput.lease.turnId,
                        ...(acceptedInput.beforeCapabilityCapture
                            ? { beforeCapabilityCapture: acceptedInput.beforeCapabilityCapture }
                            : {}),
                    }))
                    : undefined;
                if (!turnCapabilities)
                    acceptedInput.beforeCapabilityCapture?.();
                const prepared = await prepareSegmentTurn(() => this.preflight.prepare(acceptedInput, capabilityLease?.capabilities), segmentTurn);
                const assembly = await observeAgentTurnSetupStage(this.dependencies.logger, setupLogContext, 'runtime_assembly', () => capabilityLease?.capabilities
                    ? this.dependencies.agentRuntimes.normal.assembleTurn(prepared.assemblyContext, capabilityLease.capabilities)
                    : this.dependencies.agentRuntimes.normal.assembleTurn(prepared.assemblyContext));
                const assemblyObserver = this.dependencies.assemblyObserver;
                if (assemblyObserver) {
                    await observeAgentTurnSetupStage(this.dependencies.logger, setupLogContext, 'assembly_observer', () => assemblyObserver.observe({
                        context: prepared.assemblyContext,
                        assembly,
                    }));
                }
                preflight = { ...prepared, assembly };
                configHooks = await this.pluginHooks.loadConfigHooks(prepared.session);
            }
            catch (error) {
                return settleSegmentTurn(segmentTurn, await this.fail({
                    context,
                    control,
                    pipeline: undefined,
                    failures: [error],
                    message: 'Agent preflight failed.',
                }));
            }
            const executionContext = {
                ...context,
                executionModel: preflight.assemblyContext.model,
                resourceAgentName: preflight.agent.resourceAgentName ?? preflight.agent.agentName,
            };
            try {
                await observeAgentTurnSetupStage(this.dependencies.logger, setupLogContext, 'turn_start_handlers', () => runTurnStartHandlers(preflight.assembly.turnStartHandlers, preflight.assemblyContext, acceptedInput.request.requiresInputReview === true &&
                    acceptedInput.request.clientIntent !== 'retry-continuation', isUserAuthoredTurnSource(acceptedInput.request.provenance.source)));
            }
            catch (error) {
                const lifecycleFailures = await collectTurnEndHandlerFailures(preflight.assembly.turnEndHandlers, preflight.assemblyContext, 'failed');
                return settleSegmentTurn(segmentTurn, await this.fail({
                    context: executionContext,
                    control,
                    pipeline: undefined,
                    failures: [error, ...lifecycleFailures],
                    message: 'Agent turn-start handling failed.',
                }));
            }
            return await this.execute({ ...acceptedInput, session: preflight.session }, {
                context: executionContext,
                preflight,
                control,
                configHooks,
                turnTiming: {
                    acceptedAtMs: lease.acceptedAtMs,
                    hostStartedAtMs,
                    assembledAtMs: Date.now(),
                },
                ...(capabilityLease?.capabilities ? { capabilities: capabilityLease.capabilities } : {}),
                segmentTurn,
            });
        }
        finally {
            // Every failure path above returns through here, so the Turn's assembly
            // settles what it recorded for a user message exactly once.
            this.dependencies.onTurnSettled?.(context.sessionId, context.turnId);
            this.dependencies.compaction?.barrier?.endTurn(context.sessionId, context.turnId);
            capabilityLease?.release();
        }
    }
    async compact(input) {
        const acceptedInput = captureAcceptedCompactionInput(input);
        this.pluginHooks.coordinator.beginSessionActivity(acceptedInput.lease.sessionId, acceptedInput.lease.turnId);
        try {
            // The user's context reset of a Bunny main conversation runs instead, without a model request.
            const reset = await resetContextOrSkip(this.dependencies.compaction, acceptedInput, this.dependencies.ptcPrefixBaselines);
            if (reset)
                return reset;
            const capabilityLease = await this.dependencies.turnCapabilities?.acquire({
                sessionId: acceptedInput.lease.sessionId,
                turnId: acceptedInput.lease.turnId,
            });
            try {
                return await this.compactionExecutor.compact(acceptedInput, capabilityLease?.capabilities);
            }
            finally {
                capabilityLease?.release();
            }
        }
        finally {
            this.pluginHooks.coordinator.completeSessionActivity(acceptedInput.lease.sessionId);
        }
    }
    createCommitPipeline(input, context, preflight, toolCallContent) {
        return new TurnCommitPipeline({
            context,
            lease: input.lease,
            initialHistory: preflight.history,
            events: this.dependencies.events,
            committedHistory: this.committedHistory,
            ...(input.request.userMessageId ? { primaryUserMessageId: input.request.userMessageId } : {}),
            primaryUserMessageBatch: input.request.immediateSendBatch
                ? {
                    id: input.request.immediateSendBatch.id,
                    messageIds: input.request.immediateSendBatch.members.map((member) => member.userMessageId),
                }
                : undefined,
            isRuntimeErrorRetryable: this.dependencies.isRuntimeErrorRetryable ?? (() => false),
            ...(this.dependencies.alignAssistantMessageIds ? { alignAssistantMessageIds: true } : {}),
            ...(toolCallContent
                ? {
                    observedContent: {
                        userInput: () => preflight.canonicalUserInput,
                        toolCall: (toolCallId) => toolCallContent.get(toolCallId),
                        release: (toolCallId) => toolCallContent.release(toolCallId),
                    },
                }
                : {}),
        });
    }
    async execute(input, scope) {
        // Lives exactly as long as this Turn; observers read it only while the Turn runs.
        const toolCallContent = (await this.dependencies.events.observesTurnContent?.(input.lease.sessionId))
            ? new TurnToolCallContent()
            : undefined;
        try {
            const pipeline = this.createCommitPipeline(input, scope.context, scope.preflight, toolCallContent);
            const executionInput = this.createExecutionInput(input, scope, pipeline, toolCallContent);
            const runnerResult = await capture(() => this.dependencies.executor.execute(executionInput));
            const laneResult = await capture(() => pipeline.drain());
            const execution = settleCapturedExecution(runnerResult, laneResult);
            // A yielded run settles nothing: no turn_end handler, terminal or post-commit work.
            const yielded = execution.ok
                ? this.turnYield?.yielded(String(pipeline.deliveredEventCount))
                : undefined;
            if (yielded)
                return yielded;
            const outcome = await this.settleExecution(scope, pipeline, execution);
            if (scope.segmentTurn && outcome.status !== 'failed') {
                endSegmentTurn(this.dependencies.compaction?.segments, scope.context, () => this.segmentRoute(scope));
            }
            const settled = settleSegmentTurn(scope.segmentTurn, outcome);
            return this.turnYield
                ? { ...settled, continuationHint: continuationHintOf(pipeline.committedMessages) }
                : settled;
        }
        finally {
            toolCallContent?.close();
        }
    }
    /**
     * The Turn's model route for segment compaction that runs outside it: the
     * background compaction a Turn end starts, or a rebuild a Turn started and
     * stopped waiting for.
     */
    segmentRoute(scope) {
        const { context, preflight } = scope;
        const llm = preflight.preparation.llm;
        const payloadTransform = llm.auxiliaryPayloadTransform ??
            this.dependencies.buildRequestPayloadTransform?.({
                agentConfig: preflight.preparation.agentConfig,
                llm,
                sessionId: context.sessionId,
                signal: new AbortController().signal,
            });
        return segmentCompactionRoute({
            llm,
            sessionId: context.sessionId,
            turnId: context.turnId,
            ...(payloadTransform ? { payloadTransform } : {}),
            compaction: this.dependencies.compaction,
        });
    }
    createExecutionInput(input, scope, pipeline, toolCallContent) {
        const { context, preflight, control } = scope;
        const effectivePluginHooks = this.resolvePluginHooksForTurn(input.lease.sessionId, [
            ...scope.configHooks,
            ...(scope.capabilities?.hooks ?? []),
        ]);
        const pluginHookRuntimeContext = effectivePluginHooks.length
            ? this.resolvePluginHookRuntimeContext(input, preflight)
            : undefined;
        const pluginApprovalRequests = new Map();
        const pluginToolApprovalTargets = new Map();
        const pluginMcpToolOwners = exactPluginMcpToolOwners(scope.capabilities?.runtimeToolBindings ?? [], preflight.assembly.tools);
        const mcpRuleSubjects = pluginMcpRuleSubjectsInput(scope.capabilities?.runtimeToolBindings ?? [], preflight.assembly.tools);
        const kernel = bindTurnYield(this.turnYield, {
            lease: input.lease,
            resumable: input.request.executionMode === 'continuation',
            initialMessages: preflight.history.messages,
            onHistoryChanged: pipeline.onHistoryChanged,
            contextCompactionHook: this.createContextCompactionHook(input, {
                context,
                preflight,
                pluginHooks: effectivePluginHooks,
                pluginHookRuntimeContext,
                segmentTurn: scope.segmentTurn,
            }),
        });
        const yieldStop = this.yieldStopFields(input, preflight);
        return {
            lease: kernel.lease,
            request: input.request,
            session: input.session,
            agent: preflight.agent,
            preparation: preflight.preparation,
            ...turnTimingField(scope.turnTiming),
            assemblyContext: preflight.assemblyContext,
            assembly: preflight.assembly,
            history: preflight.history,
            runnerHistory: preflight.runnerHistory,
            canonicalUserInput: preflight.canonicalUserInput,
            ...(scope.capabilities ? { desktopCapabilities: scope.capabilities } : {}),
            ...mcpRuleSubjects,
            ...(effectivePluginHooks.length
                ? {
                    pluginHooks: effectivePluginHooks,
                    ...(pluginHookRuntimeContext ? { pluginHookRuntimeContext } : {}),
                    pluginApprovalRequests,
                    pluginToolApprovalTargets,
                    ...(pluginMcpToolOwners.size > 0 ? { pluginMcpToolOwners } : {}),
                }
                : {}),
            toolCallContent,
            onRuntimeEvent: pipeline.onRuntimeEvent,
            onHistoryChanged: kernel.onHistoryChanged,
            registerCanonicalUserMessageIds: pipeline.registerCanonicalUserMessageIds,
            recallOutputAttemptHistory: (attempt) => pipeline.recallOutputAttemptHistory(attempt),
            rearmPrimaryUserMessageIdAfterOutputRecall: pipeline.rearmPrimaryUserMessageIdAfterOutputRecall,
            // A run the continuation finishes writes no terminal; execute() returns its yielded outcome.
            resolveTerminalOutcome: (reconcile) => yieldStop.isYieldStopped?.() ? { status: 'aborted' } : pipeline.resolveOutcome(reconcile),
            ...yieldStop,
            ...(kernel.contextCompactionHook
                ? { contextCompactionHook: kernel.contextCompactionHook }
                : {}),
            ...segmentMainRequestObserver(this.dependencies, scope.segmentTurn),
            ...preemptionObserverOption(this.dependencies.turnTiming),
            ...segmentTurnFailureHook(scope.segmentTurn),
            control,
        };
    }
    /**
     * With aligned Display ids, tells the kernel when a yield stopped the run at
     * waiting tool calls: the `resume-tool-calls` continuation finishes that
     * output under the same id, so the kernel writes no aborted output or
     * terminal. A `tail` stop, or any stop without aligned ids, settles as a
     * cancelled run. Also names the Display id that continuation keeps for the
     * assistant whose tool calls it resumes.
     */
    yieldStopFields(input, preflight) {
        const turnYield = this.turnYield;
        const aligned = this.dependencies.alignAssistantMessageIds === true;
        const resumeAssistantMessageId = aligned && continuationRunMode(input).startMode === 'resume-tool-calls'
            ? resumeAssistantMessageIdOf(preflight.history)
            : undefined;
        return {
            ...(aligned && turnYield?.active
                ? { isYieldStopped: () => turnYield.stoppedAt === 'pending-tool-calls' }
                : {}),
            ...(resumeAssistantMessageId ? { resumeAssistantMessageId } : {}),
        };
    }
    async settleExecution(scope, pipeline, execution) {
        const { context, preflight, control } = scope;
        if (!execution.ok) {
            const lifecycleFailures = await collectTurnEndHandlerFailures(preflight.assembly.turnEndHandlers, preflight.assemblyContext, 'failed');
            return this.fail({
                context,
                control,
                pipeline,
                failures: [...execution.failures, ...lifecycleFailures],
                message: 'Agent execution failed.',
            });
        }
        const outcome = execution.outcome;
        const terminalResult = captureSync(() => pipeline.requireTerminal(outcome));
        if (!terminalResult.ok) {
            const lifecycleFailures = await collectTurnEndHandlerFailures(preflight.assembly.turnEndHandlers, preflight.assemblyContext, 'failed');
            return this.fail({
                context,
                control,
                pipeline,
                failures: [...failedOutcomeFailures(outcome), terminalResult.error, ...lifecycleFailures],
                message: 'Agent terminal staging failed.',
            });
        }
        const settleFailure = await this.settleHistorySideEffects({
            context,
            control,
            pipeline,
            outcome,
        });
        if (settleFailure) {
            const lifecycleFailures = await collectTurnEndHandlerFailures(preflight.assembly.turnEndHandlers, preflight.assemblyContext, 'failed');
            return this.fail({
                ...settleFailure,
                failures: [...settleFailure.failures, ...lifecycleFailures],
            });
        }
        const lifecycleFailures = await collectTurnEndHandlerFailures(preflight.assembly.turnEndHandlers, preflight.assemblyContext, outcome.status);
        if (lifecycleFailures.length > 0) {
            return this.fail({
                context,
                control,
                pipeline,
                failures: [...failedOutcomeFailures(outcome), ...lifecycleFailures],
                message: 'Agent turn-end handling failed.',
            });
        }
        const finalization = await capture(() => pipeline.commitOutcomeTerminal(control, terminalResult.value, outcome));
        if (!finalization.ok) {
            const failures = [...failedOutcomeFailures(outcome), ...flattenFailure(finalization.error)];
            if (outcome.status === 'failed') {
                this.logFailure(context, 'Agent terminal finalization failed.', failures);
                throwFailures(failures, 'Agent terminal finalization failed.');
            }
            return this.fail({
                context,
                control,
                pipeline,
                failures,
                message: 'Agent terminal finalization failed.',
            });
        }
        await this.commitBackgroundTaskReads(context, outcome);
        // Only now is the Turn durable: fire optional post-commit work without
        // awaiting it, so a suggestion can never delay or fail this Turn.
        this.afterSuccessfulCommit(outcome);
        return outcome;
    }
    afterSuccessfulCommit(outcome) {
        try {
            this.dependencies.executor.afterSuccessfulCommit?.(outcome);
        }
        catch {
            /* An optional post-commit observer can never fail a committed Turn. */
        }
    }
    async commitBackgroundTaskReads(context, outcome) {
        if (outcome.status !== 'completed')
            return;
        const candidateTaskIds = uniqueTaskIds(outcome.committedFacts?.backgroundTaskReadCandidates ?? []);
        if (candidateTaskIds.length === 0)
            return;
        const confirm = this.dependencies.backgroundTaskReads?.confirm;
        if (!confirm) {
            this.logBackgroundTaskReadFailure(context, 'confirmation', candidateTaskIds.length, new Error('Background task read confirmation capability is unavailable.'));
            return;
        }
        let confirmedTaskIds;
        try {
            confirmedTaskIds = uniqueTaskIds(await confirm({ sessionId: context.sessionId, taskIds: candidateTaskIds })).filter((taskId) => candidateTaskIds.includes(taskId));
        }
        catch (error) {
            this.logBackgroundTaskReadFailure(context, 'confirmation', candidateTaskIds.length, error);
            return;
        }
        if (confirmedTaskIds.length === 0)
            return;
        const settlement = {
            sessionId: context.sessionId,
            turnId: context.turnId,
            reason: 'messageDelta',
            messages: [createBackgroundTaskReadSettlement(Date.now())],
            operation: {
                id: `background-task-read-settlement:${context.turnId}`,
                kind: 'append',
            },
        };
        let lastError;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await this.committedHistory.commit(context, settlement);
                return;
            }
            catch (error) {
                lastError = error;
            }
        }
        this.logBackgroundTaskReadFailure(context, 'settlement', confirmedTaskIds.length, lastError);
    }
    logBackgroundTaskReadFailure(context, stage, taskCount, error) {
        try {
            this.dependencies.logger?.error?.({
                event: `agent_host_background_task_read_${stage}_failed`,
                session_id: context.sessionId,
                turn_id: context.turnId,
                turn_sequence: context.turnSequence,
                candidate_task_count: taskCount,
                error: describeAgentHostFailure(error),
            }, stage === 'confirmation'
                ? '[local-runtime-v2] background task read confirmation failed after Turn commit'
                : '[local-runtime-v2] background task read settlement failed after Turn commit');
        }
        catch {
            // Post-commit diagnostics cannot change the already committed Turn.
        }
    }
    resolvePluginHooksForTurn(sessionId, hooks) {
        const coordinator = this.pluginHooks.coordinator;
        const effective = coordinator.handlersForTurn(sessionId, hooks);
        if (effective.length === 0) {
            coordinator.clearAutomaticCompactionDeferral(sessionId);
        }
        return effective;
    }
    createContextCompactionHook(input, options) {
        if (!this.dependencies.compaction)
            return undefined;
        const { context, preflight, pluginHooks, pluginHookRuntimeContext } = options;
        const coordinator = this.pluginHooks.coordinator;
        return createAutomaticContextCompactionHook(this.dependencies.compaction, context, input.lease.leaseId, {
            maxSerializedInputBytes: preflight.preparation.llm.maxRequestBodyBytes,
            checkpointRequestShape: resolveCheckpointRequestShape(preflight.preparation.llm, this.dependencies.compaction.checkpointSharedPrefixEnabled),
            attempts: this.compactionAttempts,
            logger: this.dependencies.logger,
            segmentTurn: options.segmentTurn,
            ...(options.segmentTurn
                ? { segmentRoute: () => this.segmentRoute({ context, preflight }) }
                : {}),
            ...(pluginHooks.length
                ? {
                    beforeCompaction: async () => {
                        const result = await coordinator.runEvent(pluginHooks, {
                            event: 'PreCompact',
                            sessionId: input.lease.sessionId,
                            turnId: input.lease.turnId,
                            cwd: input.session.workspaceDir,
                            ...pluginHookRuntimeContext,
                            matcherValue: 'auto',
                            payload: { trigger: 'auto' },
                        }, input.lease.signal);
                        if (result.decision.continue === false || result.decision.interrupt === true) {
                            return {
                                abort: true,
                                reason: result.decision.stopReason ??
                                    result.decision.reason ??
                                    'Automatic compaction stopped by Plugin Hook.',
                            };
                        }
                        const requestedDefer = result.decision.decision === 'deny' || result.decision.defer === true;
                        return coordinator.admitAutomaticCompaction(input.lease.sessionId, requestedDefer);
                    },
                }
                : {}),
        });
    }
    resolvePluginHookRuntimeContext(input, preflight) {
        return {
            ...(this.dependencies.resolvePluginHookRuntimeContext?.(input.session) ?? {}),
            model: preflight.preparation.llm.model.id,
            ...(pluginHookEffort(preflight.preparation.llm.thinkingLevel)
                ? { effort: pluginHookEffort(preflight.preparation.llm.thinkingLevel) }
                : {}),
            promptId: input.lease.turnId,
        };
    }
    /**
     * Runs the settled-turn history side effects before `turn_end` and terminal
     * commit. A normal failed outcome preserves every acknowledged canonical
     * append, matching v1 persistence; non-fatal outcomes may carry a reconcile
     * intent. Returns a failure plan when reconciliation fails.
     */
    async settleHistorySideEffects(input) {
        const { context, control, pipeline, outcome } = input;
        if (outcome.status === 'failed')
            return undefined;
        const reconcile = outcome.historyReconcile;
        if (!reconcile)
            return undefined;
        const reconcileResult = await capture(() => pipeline.reconcileHistory(reconcile));
        if (reconcileResult.ok)
            return undefined;
        const reconcileFailures = flattenFailure(reconcileResult.error);
        const retryResult = await capture(() => pipeline.reconcileHistory(reconcile));
        if (retryResult.ok) {
            this.logRecoverableHistoryFailure(context, `Agent ${reconcile.kind} cleanup succeeded on idempotent retry.`, reconcileFailures);
            return undefined;
        }
        return {
            context,
            control,
            pipeline,
            failures: [...reconcileFailures, ...flattenFailure(retryResult.error)],
            message: 'Agent turn history reconcile failed.',
        };
    }
    logRecoverableHistoryFailure(context, stage, failures) {
        try {
            this.dependencies.logger?.info?.({
                event: 'agent_host_history_cleanup_recovered',
                session_id: context.sessionId,
                turn_id: context.turnId,
                turn_sequence: context.turnSequence,
                cleanup_stage: stage,
                failure_count: failures.length,
                errors: failures.slice(0, MAX_LOGGED_AGENT_HOST_FAILURES).map(describeAgentHostFailure),
            }, '[local-runtime-v2] agent host history cleanup recovered');
        }
        catch {
            // Diagnostics must never change the recovered Turn outcome.
        }
    }
    async fail(plan) {
        const originalError = plan.failures[0];
        const event = plan.pipeline?.failedEvent(originalError) ??
            buildHostFailedEvent(plan.context, originalError);
        const finalization = await capture(() => plan.pipeline
            ? plan.pipeline.commitFailedTerminal(plan.control, event)
            : commitHostFailedTerminal({
                context: plan.context,
                control: plan.control,
                event,
                events: this.dependencies.events,
            }));
        const failures = finalization.ok
            ? plan.failures
            : [...plan.failures, ...flattenFailure(finalization.error)];
        this.logFailure(plan.context, plan.message, failures);
        throwFailures(failures, plan.message);
    }
    logFailure(context, stage, failures) {
        try {
            const unique = [...new Set(failures)];
            const logged = unique.slice(0, MAX_LOGGED_AGENT_HOST_FAILURES);
            this.dependencies.logger?.error?.({
                session_id: context.sessionId,
                turn_id: context.turnId,
                turn_sequence: context.turnSequence,
                failure_stage: stage,
                failure_count: unique.length,
                errors: logged.map(describeAgentHostFailure),
                ...(unique.length > logged.length
                    ? { truncated_failure_count: unique.length - logged.length }
                    : {}),
                ...(context.clientRequestId ? { client_request_id: context.clientRequestId } : {}),
                ...(context.provenance?.source ? { conversation_source: context.provenance.source } : {}),
                ...(context.queueItemIds ? { queue_item_count: context.queueItemIds.length } : {}),
            }, '[local-runtime-v2] agent host turn failed');
        }
        catch {
            // Diagnostics must never mask or replace the owning AgentHost failure.
        }
    }
}
//# sourceMappingURL=local-agent-host.js.map