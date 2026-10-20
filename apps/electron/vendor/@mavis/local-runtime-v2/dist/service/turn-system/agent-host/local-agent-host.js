import { pluginHookEffort } from '@mavis/plugin-hooks';
import { hasAcceptedLeaseIdentity, isAbortSignalLike } from './accepted-lease.js';
import { captureAgentHostExecutionRequest } from './canonical-user-input.js';
import { AgentHostCompactionExecutor, AgentHostCompactionLeaseError, AgentCompactionCloseError, AgentCompactionAssociationError, AgentCompactionSnapshotError, captureAcceptedCompactionInput, } from './compaction/agent-host-compaction-executor.js';
import { ContextCompactionAttemptFactory, createAutomaticContextCompactionHook, } from './compaction/context-compaction.js';
import { assertAgentHostCapabilityAvailable, assertAgentHostCompactionDependenciesReady, assertAgentHostDependenciesReady, } from './empty-dependencies.js';
import { buildHostFailedEvent } from './events/host-failed-event.js';
import { AgentHostCommittedHistoryWriter } from './history/committed-history-writer.js';
import { createBackgroundTaskReadSettlement } from './history/background/task-read-settlement.js';
import { AgentHistoryOperationIdentityError } from './history/history-operation-replay.js';
import { AgentTerminalConfirmationError, TurnCommitPipeline, commitHostFailedTerminal, } from './events/turn-commit-pipeline.js';
import { AgentHostSessionReadError } from './preparation/session-read.js';
import { AgentEventAssociationError, AgentExecutionSnapshotNotFoundError, TurnPreflight, observeAgentTurnSetupStage, } from './preparation/turn-preflight.js';
import { localPluginHookCoordinator } from './assembly/local-turn-plugin-hooks.js';
export class AgentEventIdentityError extends Error {
    name = 'AgentEventIdentityError';
    constructor(kind) {
        super(`Cannot derive a stable identity for ${kind}.`);
    }
}
export class AgentHostTurnSequenceError extends Error {
    acceptedSequence;
    name = 'AgentHostTurnSequenceError';
    constructor(acceptedSequence) {
        super('AgentHost acceptedSequence must be a finite positive integer.');
        this.acceptedSequence = acceptedSequence;
    }
}
export class AgentHostTurnLeaseError extends Error {
    reason;
    name = 'AgentHostTurnLeaseError';
    constructor(reason) {
        super(`AgentHost accepted Turn lease is invalid: ${reason}.`);
        this.reason = reason;
    }
}
export { AgentEventAssociationError, AgentExecutionSnapshotNotFoundError, AgentCompactionAssociationError, AgentCompactionCloseError, AgentHistoryOperationIdentityError, AgentCompactionSnapshotError, AgentHostCompactionLeaseError, AgentHostSessionReadError, AgentTerminalConfirmationError, };
/** Ordered, fail-closed adapter between Turn ownership and the Agent loop. */
export class LocalAgentHost {
    dependencies;
    committedHistory;
    compactionAttempts = new ContextCompactionAttemptFactory();
    compactionExecutor;
    preflight;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.committedHistory = new AgentHostCommittedHistoryWriter({
            history: dependencies.history,
            events: dependencies.events,
            ...(dependencies.historyFailure ? { historyFailure: dependencies.historyFailure } : {}),
            ...(dependencies.compaction ? { compaction: dependencies.compaction } : {}),
            ...(dependencies.usage ? { usage: dependencies.usage } : {}),
        });
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
            ...(dependencies.compaction ? { compaction: dependencies.compaction } : {}),
            ...(dependencies.logger ? { logger: dependencies.logger } : {}),
            assertReady: () => assertAgentHostCompactionDependenciesReady(dependencies),
        }, this.committedHistory, this.compactionAttempts);
        this.preflight = new TurnPreflight(dependencies);
    }
    async run(input) {
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
                setupLogContext.executionMode = acceptedInput.request.executionMode ?? 'activate';
                const turnCapabilities = this.dependencies.turnCapabilities;
                capabilityLease = turnCapabilities
                    ? await observeAgentTurnSetupStage(this.dependencies.logger, setupLogContext, 'capability_acquisition', () => turnCapabilities.acquire({
                        sessionId: acceptedInput.lease.sessionId,
                        turnId: acceptedInput.lease.turnId,
                        signal: acceptedInput.lease.signal,
                        ...(acceptedInput.beforeCapabilityCapture
                            ? { beforeCapabilityCapture: acceptedInput.beforeCapabilityCapture }
                            : {}),
                    }))
                    : undefined;
                if (!turnCapabilities)
                    acceptedInput.beforeCapabilityCapture?.();
                const prepared = await this.preflight.prepare(acceptedInput, capabilityLease?.capabilities);
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
            }
            catch (error) {
                return this.fail({
                    context,
                    control,
                    pipeline: undefined,
                    failures: [error],
                    message: 'Agent preflight failed.',
                });
            }
            const executionContext = {
                ...context,
                executionModel: preflight.assemblyContext.model,
                resourceAgentName: preflight.agent.resourceAgentName ?? preflight.agent.agentName,
            };
            try {
                await observeAgentTurnSetupStage(this.dependencies.logger, setupLogContext, 'turn_start_handlers', () => runTurnStartHandlers(preflight.assembly.turnStartHandlers, preflight.assemblyContext, acceptedInput.request.requiresInputReview === true &&
                    acceptedInput.request.clientIntent !== 'retry-continuation'));
            }
            catch (error) {
                const lifecycleFailures = await collectTurnEndHandlerFailures(preflight.assembly.turnEndHandlers, preflight.assemblyContext, 'failed');
                return this.fail({
                    context: executionContext,
                    control,
                    pipeline: undefined,
                    failures: [error, ...lifecycleFailures],
                    message: 'Agent turn-start handling failed.',
                });
            }
            return await this.execute({ ...acceptedInput, session: preflight.session }, {
                context: executionContext,
                preflight,
                control,
                ...(capabilityLease?.capabilities ? { capabilities: capabilityLease.capabilities } : {}),
            });
        }
        finally {
            this.dependencies.compaction?.barrier?.endTurn(context.sessionId, context.turnId);
            capabilityLease?.release();
        }
    }
    async compact(input) {
        const acceptedInput = captureAcceptedCompactionInput(input);
        localPluginHookCoordinator.beginSessionActivity(acceptedInput.lease.sessionId, acceptedInput.lease.turnId);
        try {
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
            localPluginHookCoordinator.completeSessionActivity(acceptedInput.lease.sessionId);
        }
    }
    createCommitPipeline(input, context, preflight) {
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
        });
    }
    async execute(input, scope) {
        const pipeline = this.createCommitPipeline(input, scope.context, scope.preflight);
        const executionInput = this.createExecutionInput(input, scope, pipeline);
        const runnerResult = await capture(() => this.dependencies.executor.execute(executionInput));
        const laneResult = await capture(() => pipeline.drain());
        return this.settleExecution(scope, pipeline, settleCapturedExecution(runnerResult, laneResult));
    }
    createExecutionInput(input, scope, pipeline) {
        const { context, preflight, control } = scope;
        const effectivePluginHooks = this.resolvePluginHooksForTurn(input.lease.sessionId, scope.capabilities?.hooks ?? []);
        const pluginHookRuntimeContext = effectivePluginHooks.length
            ? this.resolvePluginHookRuntimeContext(input, preflight)
            : undefined;
        const pluginApprovalRequests = new Map();
        const pluginHostApprovalTargets = new Map();
        const pluginMcpToolOwners = exactPluginMcpToolOwners(scope.capabilities?.runtimeToolBindings ?? []);
        const contextCompactionHook = this.createContextCompactionHook(input, {
            context,
            preflight,
            pluginHooks: effectivePluginHooks,
            pluginHookRuntimeContext,
        });
        return {
            lease: input.lease,
            request: input.request,
            session: input.session,
            agent: preflight.agent,
            preparation: preflight.preparation,
            assemblyContext: preflight.assemblyContext,
            assembly: preflight.assembly,
            history: preflight.history,
            runnerHistory: preflight.runnerHistory,
            canonicalUserInput: preflight.canonicalUserInput,
            ...(scope.capabilities ? { desktopCapabilities: scope.capabilities } : {}),
            ...(effectivePluginHooks.length
                ? {
                    pluginHooks: effectivePluginHooks,
                    ...(pluginHookRuntimeContext ? { pluginHookRuntimeContext } : {}),
                    pluginApprovalRequests,
                    pluginHostApprovalTargets,
                    ...(pluginMcpToolOwners.size > 0 ? { pluginMcpToolOwners } : {}),
                }
                : {}),
            onRuntimeEvent: pipeline.onRuntimeEvent,
            onHistoryChanged: pipeline.onHistoryChanged,
            registerCanonicalUserMessageIds: pipeline.registerCanonicalUserMessageIds,
            recallOutputAttemptHistory: (attempt) => pipeline.recallOutputAttemptHistory(attempt),
            rearmPrimaryUserMessageIdAfterOutputRecall: pipeline.rearmPrimaryUserMessageIdAfterOutputRecall,
            resolveTerminalOutcome: (reconcile) => pipeline.resolveOutcome(reconcile),
            ...(contextCompactionHook ? { contextCompactionHook } : {}),
            control,
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
        return outcome;
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
        const effective = localPluginHookCoordinator.handlersForTurn(sessionId, hooks);
        if (effective.length === 0) {
            localPluginHookCoordinator.clearAutomaticCompactionDeferral(sessionId);
        }
        return effective;
    }
    createContextCompactionHook(input, options) {
        if (!this.dependencies.compaction)
            return undefined;
        const { context, preflight, pluginHooks, pluginHookRuntimeContext } = options;
        return createAutomaticContextCompactionHook(this.dependencies.compaction, context, input.lease.leaseId, {
            maxSerializedInputBytes: preflight.preparation.llm.maxRequestBodyBytes,
            attempts: this.compactionAttempts,
            logger: this.dependencies.logger,
            ...(pluginHooks.length
                ? {
                    beforeCompaction: async () => {
                        const result = await localPluginHookCoordinator.runEvent(pluginHooks, {
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
                        return localPluginHookCoordinator.admitAutomaticCompaction(input.lease.sessionId, requestedDefer);
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
const MAX_LOGGED_AGENT_HOST_FAILURES = 4;
const MAX_LOGGED_ERROR_MESSAGE_LENGTH = 1_024;
const MAX_LOGGED_ERROR_STACK_LENGTH = 4_096;
function describeAgentHostFailure(error) {
    if (error instanceof Error) {
        return {
            name: error.name || 'Error',
            message: truncateLogText(error.message || 'Unknown error', MAX_LOGGED_ERROR_MESSAGE_LENGTH),
            ...(error.stack
                ? { stack: truncateLogText(error.stack, MAX_LOGGED_ERROR_STACK_LENGTH) }
                : {}),
        };
    }
    return {
        name: typeof error,
        message: truncateLogText(safeErrorText(error), MAX_LOGGED_ERROR_MESSAGE_LENGTH),
    };
}
function safeErrorText(error) {
    try {
        return String(error);
    }
    catch {
        return 'Unknown non-Error failure';
    }
}
function truncateLogText(value, maximum) {
    return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}
async function capture(operation) {
    try {
        return success(await operation());
    }
    catch (error) {
        return { ok: false, error };
    }
}
function captureSync(operation) {
    try {
        return success(operation());
    }
    catch (error) {
        return { ok: false, error };
    }
}
function success(value) {
    return { ok: true, value };
}
function compactFailures(results) {
    return results.flatMap((result) => (result.ok ? [] : flattenFailure(result.error)));
}
function settleCapturedExecution(runner, lane) {
    if (!runner.ok)
        return { ok: false, failures: compactFailures([runner, lane]) };
    if (!lane.ok) {
        return {
            ok: false,
            failures: [...failedOutcomeFailures(runner.value), ...compactFailures([lane])],
        };
    }
    return { ok: true, outcome: runner.value };
}
function failedOutcomeFailures(outcome) {
    return outcome.status === 'failed' ? [outcome.error] : [];
}
function flattenFailure(error) {
    return error instanceof AggregateError ? error.errors.flatMap(flattenFailure) : [error];
}
function throwFailures(failures, message) {
    const unique = [...new Set(failures)];
    if (unique.length === 1)
        throw unique[0];
    throw new AggregateError(unique, message);
}
async function runTurnStartHandlers(handlers, context, isOrdinaryInputTurn) {
    await runSequential(handlers, (handler) => handler({
        sessionId: context.sessionId,
        turnId: context.turnId,
        agentName: context.agentName,
        workspaceDir: context.workspaceDir,
        history: context.history,
        userInput: context.userInput,
        isOrdinaryInputTurn,
    }, context));
}
async function collectTurnEndHandlerFailures(handlers, context, reason, index = 0) {
    const handler = handlers[index];
    if (!handler)
        return [];
    const result = await capture(async () => {
        await handler({
            sessionId: context.sessionId,
            turnId: context.turnId,
            agentName: context.agentName,
            workspaceDir: context.workspaceDir,
            reason,
        }, context);
    });
    const remaining = await collectTurnEndHandlerFailures(handlers, context, reason, index + 1);
    return result.ok ? remaining : [result.error, ...remaining];
}
async function runSequential(values, visit, index = 0) {
    const value = values[index];
    if (value === undefined)
        return;
    await visit(value);
    await runSequential(values, visit, index + 1);
}
function scopeTurnControl(dependencies, lease) {
    const control = dependencies.turnControl.scope(lease);
    assertAgentHostCapabilityAvailable('turn-control', [
        control?.drainSteering,
        control?.tryBeginClose,
        control?.sealAbnormalTerminal,
        control?.openToolResultTail,
        control?.closeAndClaimToolResultTail,
        control?.ackToolResultTail,
    ].every((operation) => typeof operation === 'function'));
    return control;
}
function createBaseAgentEventContext(input) {
    return {
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        turnSequence: input.lease.acceptedSequence,
    };
}
function exactPluginMcpToolOwners(bindings) {
    const owners = new Map();
    const ambiguous = new Set();
    for (const binding of bindings) {
        if (binding.kind !== 'mcp' || !binding.pluginName?.trim())
            continue;
        const toolName = binding.tool.def.name;
        const existing = owners.get(toolName);
        if (existing && existing !== binding.pluginName) {
            owners.delete(toolName);
            ambiguous.add(toolName);
            continue;
        }
        if (!ambiguous.has(toolName))
            owners.set(toolName, binding.pluginName);
    }
    return owners;
}
function createAgentEventContext(input) {
    const base = createBaseAgentEventContext(input);
    return {
        ...base,
        ...(input.request.queueItemIds ? { queueItemIds: [...input.request.queueItemIds] } : {}),
        provenance: {
            source: input.request.provenance.source,
            ...(input.request.provenance.sourceContext
                ? { sourceContext: { ...input.request.provenance.sourceContext } }
                : {}),
            routingFingerprint: input.request.provenance.routingFingerprint,
        },
        ...(input.request.clientRequestId ? { clientRequestId: input.request.clientRequestId } : {}),
    };
}
function validateAcceptedSequence(acceptedSequence) {
    if (typeof acceptedSequence !== 'number' ||
        !Number.isFinite(acceptedSequence) ||
        !Number.isSafeInteger(acceptedSequence) ||
        acceptedSequence <= 0) {
        throw new AgentHostTurnSequenceError(acceptedSequence);
    }
}
function captureAcceptedTurnLease(value) {
    if (!value || typeof value !== 'object') {
        throw new AgentHostTurnLeaseError('identity');
    }
    const candidate = {
        sessionId: readUnknownProperty(value, 'sessionId'),
        turnId: readUnknownProperty(value, 'turnId'),
        leaseId: readUnknownProperty(value, 'leaseId'),
        acceptedSequence: readUnknownProperty(value, 'acceptedSequence'),
        acceptedAtMs: readUnknownProperty(value, 'acceptedAtMs'),
        signal: readUnknownProperty(value, 'signal'),
        busyReason: readUnknownProperty(value, 'busyReason'),
    };
    if (!hasAcceptedLeaseIdentity(candidate)) {
        throw new AgentHostTurnLeaseError('identity');
    }
    if (candidate.busyReason !== 'turn') {
        throw new AgentHostTurnLeaseError('busy-reason');
    }
    if (!isAcceptedAtMs(candidate.acceptedAtMs)) {
        throw new AgentHostTurnLeaseError('identity');
    }
    if (!isAbortSignalLike(candidate.signal)) {
        throw new AgentHostTurnLeaseError('signal');
    }
    validateAcceptedSequence(candidate.acceptedSequence);
    return Object.freeze({
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        leaseId: candidate.leaseId,
        acceptedSequence: candidate.acceptedSequence,
        acceptedAtMs: candidate.acceptedAtMs,
        signal: candidate.signal,
        busyReason: candidate.busyReason,
    });
}
function readUnknownProperty(value, key) {
    return Reflect.get(value, key);
}
function uniqueTaskIds(values) {
    return [
        ...new Set(values.filter((value) => typeof value === 'string' && value.trim().length > 0)),
    ];
}
function isAcceptedAtMs(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
//# sourceMappingURL=local-agent-host.js.map