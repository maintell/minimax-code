import { composeStreamFn, recordPiLLMCallMetrics, withLLMRetry, } from '@mavis/agent-core/pi-turn-runner';
import { readSessionAgentExecutionSnapshot } from '../preparation/session-agent-execution-snapshot.js';
import { createSecretFreeModelContextAssemblyContext } from '../assembly-context.js';
import { AgentHostDependencyUnavailableError } from '../empty-dependencies.js';
import { hasAcceptedLeaseIdentity, isAbortSignalLike } from '../accepted-lease.js';
import { copyCanonicalHistoryForPiCompatibility, validateCanonicalHistoryChange, } from '../history/canonical-history-validation.js';
import { AgentHostCommittedHistoryWriter } from '../history/committed-history-writer.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import { captureContextCompactionResult, ContextCompactionAttemptFactory, ContextCompactionResultValidationError, createCompactionTokenUsageAccumulator, describeUnknownError, logCheckpointGeneratedBestEffort, logCompactionFailureBestEffort, observeCompactionBestEffort, recordCheckpointAttemptBestEffort, } from './context-compaction.js';
import { recordSharedPrefixFallbackBestEffort, resolveCheckpointRequestShape, } from './checkpoint-request-shape.js';
import { createCompactionLifecycleMetadata, createManualCompactionChange, } from './compaction-history.js';
import { joinPrompt, readPreparedContextUsagePromptRanges, readPreparedSystemPrompt, resolveProviderContextMode, } from '../execution/prompt.js';
import { loadLocalConfigHooks, localPluginHookCoordinator, } from '../assembly/local-turn-plugin-hooks.js';
import { createAgentHostPluginHookTranscript, } from '../tools/index.js';
export class AgentHostCompactionLeaseError extends Error {
    reason;
    name = 'AgentHostCompactionLeaseError';
    constructor(reason) {
        super(`AgentHost accepted compaction lease is invalid: ${reason}.`);
        this.reason = reason;
    }
}
export class AgentCompactionCloseError extends Error {
    reason;
    name = 'AgentCompactionCloseError';
    constructor(reason) {
        super(`AgentHost compaction close was refused: ${reason}.`);
        this.reason = reason;
    }
}
export class AgentCompactionAssociationError extends Error {
    field;
    name = 'AgentCompactionAssociationError';
    constructor(field) {
        super(`AgentHost compaction ${field} does not match its accepted snapshot.`);
        this.field = field;
    }
}
export class AgentCompactionSnapshotError extends Error {
    field;
    name = 'AgentCompactionSnapshotError';
    constructor(field) {
        super(`AgentHost compaction ${field} snapshot is unavailable or invalid.`);
        this.field = field;
    }
}
async function manualCompactionHooks(session, capabilities) {
    return [...(await loadLocalConfigHooks(session)), ...(capabilities?.hooks ?? [])];
}
async function preCompactHookRejection(input, hooks, cwd, runtimeContext) {
    if (!hooks.length)
        return undefined;
    const result = await localPluginHookCoordinator.runEvent(hooks, {
        event: 'PreCompact',
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        cwd,
        ...runtimeContext,
        matcherValue: 'manual',
        payload: {
            trigger: 'manual',
            ...(input.customInstructions ? { custom_instructions: input.customInstructions } : {}),
        },
    }, input.lease.signal);
    if (result.decision.continue === false) {
        return result.decision.stopReason ?? 'stopped by Plugin Hook';
    }
    if (result.decision.decision !== 'deny' && result.decision.defer !== true)
        return undefined;
    return result.decision.reason ?? 'deferred by Plugin Hook';
}
async function notifyPostCompact(plan) {
    const { input, hooks, cwd, runtimeContext, compactSummary } = plan;
    if (!hooks.length)
        return undefined;
    const result = await localPluginHookCoordinator.runEvent(hooks, {
        event: 'PostCompact',
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        cwd,
        ...runtimeContext,
        matcherValue: 'manual',
        payload: {
            trigger: 'manual',
            compact_summary: compactSummary ?? '',
        },
    }, input.lease.signal);
    localPluginHookCoordinator.completeAutomaticCompaction(input.lease.sessionId);
    localPluginHookCoordinator.markCompacted(input.lease.sessionId, hooks);
    return result.decision.continue === false
        ? (result.decision.stopReason ?? 'Processing stopped by PostCompact Plugin Hook.')
        : undefined;
}
export class AgentHostCompactionExecutor {
    dependencies;
    committedHistory;
    compactionAttempts;
    constructor(dependencies, committedHistory, compactionAttempts = new ContextCompactionAttemptFactory()) {
        this.dependencies = dependencies;
        this.committedHistory = committedHistory;
        this.compactionAttempts = compactionAttempts;
    }
    async compact(rawInput, desktopCapabilities) {
        const input = captureAcceptedCompactionInput(rawInput);
        this.dependencies.assertReady();
        const compactionDependencies = this.requireCompaction();
        const context = createCompactionContext(input);
        const attemptId = this.compactionAttempts.create(context, input.lease.leaseId, 'manual');
        await compactionDependencies.barrier?.begin(context.sessionId, attemptId, context.turnId);
        try {
            const state = {
                thinkingLevel: 'off',
                tokenUsage: createCompactionTokenUsageAccumulator(),
            };
            if (input.lease.signal.aborted) {
                return await this.failPrepared({
                    context,
                    attemptId,
                    error: abortError(input.lease.signal),
                    abortedReason: abortReason(input),
                });
            }
            const captured = await capture(async () => {
                const session = captureSession(input.lease.sessionId, await this.dependencies.sessions.get(input.lease.sessionId));
                const history = captureSemanticSnapshot(await this.dependencies.history.read(input.lease.sessionId)).value;
                validateHistory(history);
                const piHistory = captureSemanticSnapshot(copyCanonicalHistoryForPiCompatibility(history.messages)).value;
                return { session, history, piHistory };
            });
            if (!captured.ok) {
                logCompactionFailureBestEffort(this.dependencies.logger, {
                    context,
                    attemptId,
                    phase: 'manual',
                    thinkingLevel: state.thinkingLevel,
                    checkpoint: state.checkpoint,
                    error: captured.error,
                });
                return await this.failPrepared({
                    context,
                    attemptId,
                    error: captured.error,
                    tokenUsage: state.tokenUsage,
                });
            }
            return await this.runManualCompaction({
                input,
                ...captured.value,
                desktopCapabilities,
                context,
                attemptId,
                state,
                compactionDependencies,
            });
        }
        finally {
            compactionDependencies.barrier?.end(context.sessionId, attemptId);
        }
    }
    async runManualCompaction(plan) {
        const { input, session, history, piHistory, desktopCapabilities, context, attemptId, state, compactionDependencies, } = plan;
        const hostPluginHookRuntimeContext = {
            ...(this.dependencies.resolvePluginHookRuntimeContext?.(session) ?? {}),
            ...(session.effectiveModel ? { model: session.effectiveModel } : {}),
            promptId: input.lease.turnId,
        };
        const pluginTranscript = await createManualCompactionHookTranscript(hostPluginHookRuntimeContext.transcriptPath ??
            hostPluginHookRuntimeContext.codexTranscriptPath, input.lease.sessionId, session.workspaceDir, piHistory);
        const pluginHookRuntimeContext = pluginTranscript
            ? {
                ...hostPluginHookRuntimeContext,
                transcriptPath: pluginTranscript.path,
                codexTranscriptPath: pluginTranscript.codexPath,
            }
            : {
                ...hostPluginHookRuntimeContext,
                transcriptPath: null,
                codexTranscriptPath: null,
            };
        const hooks = await manualCompactionHooks(session, desktopCapabilities);
        try {
            const hookRejection = await preCompactHookRejection(input, hooks, session.workspaceDir, pluginHookRuntimeContext);
            if (hookRejection)
                return { status: 'aborted', reason: hookRejection };
            const prepared = await this.prepareManualCompaction({
                input,
                session,
                history,
                piHistory,
                desktopCapabilities,
                context,
                attemptId,
                state,
                compactionDependencies,
            });
            if (!prepared.ok) {
                const aborted = input.lease.signal.aborted;
                logCompactionFailureBestEffort(this.dependencies.logger, {
                    context,
                    attemptId,
                    phase: 'manual',
                    thinkingLevel: state.thinkingLevel,
                    checkpoint: state.checkpoint,
                    error: prepared.error,
                });
                return this.failPrepared({
                    context,
                    attemptId,
                    error: prepared.error,
                    ...(aborted ? { abortedReason: abortReason(input) } : {}),
                    tokenUsage: state.tokenUsage,
                });
            }
            if (prepared.value.status === 'unchanged') {
                observeCompactionBestEffort(compactionDependencies.observer, {
                    context,
                    attemptId,
                    status: 'unchanged',
                    reason: prepared.value.compaction.reason,
                });
                return prepared.value.compaction;
            }
            const outcome = await this.commitPrepared({
                input,
                context,
                attemptId,
                compaction: prepared.value.compaction,
                change: prepared.value.change,
            });
            return this.finishCommittedPluginCompaction({
                input,
                hooks,
                cwd: session.workspaceDir,
                runtimeContext: pluginHookRuntimeContext,
                summary: prepared.value.compaction.summary ?? '',
                outcome,
                transcript: pluginTranscript,
                replacementMessages: prepared.value.compaction.replacementMessages,
            });
        }
        finally {
            await pluginTranscript?.cleanup();
        }
    }
    async prepareManualCompaction(plan) {
        const { input, session, history, piHistory, desktopCapabilities, context, attemptId, state, compactionDependencies, } = plan;
        return capture(async () => {
            const agent = await readSessionAgentExecutionSnapshot(this.dependencies.agents, session);
            if (!agent)
                throw new AgentCompactionSnapshotError('agent');
            if (agent.agentName !== session.agentName) {
                throw new AgentCompactionAssociationError('agentName');
            }
            const preparation = await compactionDependencies.preparation.prepareCompaction({
                turnId: input.lease.turnId,
                session,
                agent,
                history,
                ...(desktopCapabilities ? { desktopCapabilities } : {}),
            });
            const { thinkingLevel = 'off' } = preparation.llm;
            state.thinkingLevel = thinkingLevel;
            const assemblyContext = createSecretFreeModelContextAssemblyContext({
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                session,
                agent,
                preparation,
                history: piHistory,
            });
            const assembly = await this.dependencies.assembleModelContext(assemblyContext, desktopCapabilities);
            const streamFn = withLLMRetry(composeStreamFn(preparation.llm), {
                sessionId: input.lease.sessionId,
                turnId: input.lease.turnId,
                scope: 'compaction',
                onCallSettled: (event) => recordPiLLMCallMetrics(compactionDependencies.metricsClient, 'compact', event),
            });
            const payloadTransform = this.dependencies.buildRequestPayloadTransform?.({
                agentConfig: preparation.agentConfig,
                llm: preparation.llm,
                sessionId: input.lease.sessionId,
                signal: input.lease.signal,
            });
            const baseSystemPrompt = readPreparedSystemPrompt(preparation.agentConfig);
            const contextUsagePromptRanges = readPreparedContextUsagePromptRanges(preparation.agentConfig, assembly.systemPromptPrefix, baseSystemPrompt);
            const providerContext = resolveProviderContextMode(session, {
                systemPrompt: joinPrompt(assembly.systemPromptPrefix, baseSystemPrompt),
                tools: assembly.tools.map(({ def }) => ({
                    name: def.name,
                    description: def.description,
                    parameters: def.schema,
                })),
                ...(contextUsagePromptRanges === undefined ? {} : { contextUsagePromptRanges }),
            }, 'compaction');
            const compaction = captureContextCompactionResult(await compactionDependencies.manual.compactManual(createManualCompactionRequest({
                input,
                messages: piHistory,
                preparation,
                thinkingLevel,
                streamFn,
                payloadTransform,
                systemPrompt: providerContext.systemPrompt,
                tools: [...providerContext.tools],
                contextUsagePromptRanges: providerContext.contextUsagePromptRanges,
                checkpointRequestShape: resolveCheckpointRequestShape(preparation.llm, compactionDependencies.checkpointSharedPrefixEnabled),
            }), {
                onStarted: () => observeCompactionBestEffort(compactionDependencies.observer, {
                    context,
                    attemptId,
                    status: 'started',
                    reason: 'manual',
                }),
                onCheckpointGenerated: (metadata) => {
                    state.checkpoint = logCheckpointGeneratedBestEffort(this.dependencies.logger, {
                        context,
                        attemptId,
                        phase: 'manual',
                        thinkingLevel,
                        checkpoint: metadata,
                    });
                },
                onCheckpointAttemptSettled: (metadata) => recordCheckpointAttemptBestEffort(this.dependencies.logger, compactionDependencies.metricsClient, {
                    context,
                    attemptId,
                    phase: 'manual',
                    thinkingLevel,
                    checkpoint: metadata,
                }),
                onCheckpointSharedPrefixFallback: (reason) => recordSharedPrefixFallbackBestEffort(this.dependencies.logger, compactionDependencies.metricsClient, {
                    context,
                    attemptId,
                    phase: 'manual',
                    api: preparation.llm.model.api,
                    reason,
                }),
                onProviderRequestSettled: state.tokenUsage.observe,
                getProviderTokenUsage: state.tokenUsage.snapshot,
            }), history.messages.length);
            if (compaction.status === 'unchanged')
                return { status: 'unchanged', compaction };
            const completed = requireManualCompletedCompaction(compaction);
            const change = createManualCompactionChange(input, history.messages, completed, attemptId);
            validateCanonicalHistoryChange(change, 'replace');
            return { status: 'completed', compaction: completed, change };
        });
    }
    async finishCommittedPluginCompaction(plan) {
        if (plan.outcome.status !== 'completed')
            return plan.outcome;
        const runtimeContext = await updateManualCompactionHookTranscript(plan.transcript, plan.runtimeContext, plan.input, plan.replacementMessages);
        const hookStopReason = await notifyPostCompact({
            input: plan.input,
            hooks: plan.hooks,
            cwd: plan.cwd,
            runtimeContext,
            compactSummary: plan.summary,
        });
        return hookStopReason ? { ...plan.outcome, hookStopReason } : plan.outcome;
    }
    async commitPrepared(plan) {
        const { input, context, attemptId, compaction, change } = plan;
        const metadata = createCompactionLifecycleMetadata(compaction, 'manual', attemptId);
        const compactionDependencies = this.requireCompaction();
        if (input.lease.signal.aborted) {
            return this.failPrepared({
                context,
                attemptId,
                error: abortError(input.lease.signal),
                metadata,
                abortedReason: abortReason(input),
            });
        }
        const close = captureSync(() => compactionDependencies.control.beginClose(input.lease));
        if (!close.ok) {
            return this.failPrepared({ context, attemptId, error: close.error, metadata });
        }
        if (!close.value.closed) {
            const closeError = new AgentCompactionCloseError(close.value.reason);
            if (close.value.reason === 'stale-lease' || close.value.reason === 'aborted') {
                return this.failPrepared({
                    context,
                    attemptId,
                    error: closeError,
                    metadata,
                    abortedReason: close.value.reason === 'aborted'
                        ? (close.value.abortReason ?? 'aborted')
                        : 'stale-lease',
                });
            }
            return this.failPrepared({ context, attemptId, error: closeError, metadata });
        }
        const committed = await capture(() => this.committedHistory.commit(context, change, {
            compactionAttemptId: attemptId,
        }));
        if (!committed.ok)
            return { status: 'failed', error: committed.error };
        return {
            status: 'completed',
            compactionId: compaction.compactionId,
            messagesBefore: compaction.messagesBefore,
            messagesAfter: compaction.messagesAfter,
            tokensBefore: compaction.tokensBefore,
            tokensAfter: compaction.tokensAfter,
            ...(compaction.contextUsage === undefined ? {} : { contextUsage: compaction.contextUsage }),
        };
    }
    async failPrepared(plan) {
        const { context, attemptId, error, metadata, abortedReason } = plan;
        const compactionDependencies = this.requireCompaction();
        const tokenUsage = metadata?.tokenUsage ?? plan.tokenUsage?.snapshot();
        const lifecycle = await capture(() => compactionDependencies.lifecycle.failCommittedHistory({
            context,
            attemptId,
            error,
            ...(metadata ? { metadata } : {}),
        }));
        observeCompactionBestEffort(compactionDependencies.observer, {
            context,
            attemptId,
            status: abortedReason ? 'aborted' : 'failed',
            ...(metadata ? { compactionId: metadata.compactionId } : {}),
            reason: abortedReason ?? describeUnknownError(error),
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
        });
        if (lifecycle.ok && abortedReason) {
            return { status: 'aborted', ...(abortedReason ? { reason: abortedReason } : {}) };
        }
        const failures = lifecycle.ok
            ? flattenFailure(error)
            : [...flattenFailure(error), ...flattenFailure(lifecycle.error)];
        return { status: 'failed', error: aggregateFailures(failures) };
    }
    requireCompaction() {
        const compaction = this.dependencies.compaction;
        if (!compaction)
            throw new AgentHostDependencyUnavailableError('context-compactor');
        return compaction;
    }
}
function createManualCompactionRequest(plan) {
    const { input, messages, preparation, thinkingLevel, streamFn, payloadTransform, systemPrompt } = plan;
    return {
        sessionId: input.lease.sessionId,
        messages,
        model: preparation.llm.model,
        thinkingLevel,
        maxSerializedInputBytes: preparation.llm.maxRequestBodyBytes,
        ...(preparation.llm.apiKey === undefined ? {} : { apiKey: preparation.llm.apiKey }),
        ...(preparation.llm.headers === undefined ? {} : { headers: preparation.llm.headers }),
        streamFn,
        ...(preparation.llm.maxTokens === undefined ? {} : { maxTokens: preparation.llm.maxTokens }),
        ...(preparation.llm.cacheRetention === undefined
            ? {}
            : { cacheRetention: preparation.llm.cacheRetention }),
        ...(payloadTransform === undefined ? {} : { payloadTransform }),
        signal: input.lease.signal,
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
        systemPrompt,
        tools: plan.tools,
        ...(plan.contextUsagePromptRanges === undefined
            ? {}
            : { contextUsagePromptRanges: plan.contextUsagePromptRanges }),
        ...(plan.checkpointRequestShape === 'isolated'
            ? {}
            : { checkpointRequestShape: plan.checkpointRequestShape }),
    };
}
async function createManualCompactionHookTranscript(hostTranscriptPath, sessionId, cwd, messages) {
    if (!hostTranscriptPath)
        return undefined;
    try {
        return await createAgentHostPluginHookTranscript({
            cwd,
            sessionId,
            messages,
        });
    }
    catch {
        // A vendor transcript is optional evidence. Never expose the native Pi
        // transcript as a fallback because neither Compatible nor Codex can parse it.
        return undefined;
    }
}
async function updateManualCompactionHookTranscript(transcript, runtimeContext, input, replacementMessages) {
    if (!transcript)
        return runtimeContext;
    try {
        await transcript.apply({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            reason: 'replaceMessages',
            messages: copyCanonicalHistoryForPiCompatibility(replacementMessages),
        });
        return runtimeContext;
    }
    catch {
        return { ...runtimeContext, transcriptPath: null, codexTranscriptPath: null };
    }
}
function requireManualCompletedCompaction(result) {
    if (result.status !== 'completed') {
        throw new ContextCompactionResultValidationError('manualStatus');
    }
    return result;
}
function createCompactionContext(input) {
    return captureSemanticSnapshot({
        sessionId: input.lease.sessionId,
        turnId: input.lease.turnId,
        turnSequence: input.lease.acceptedSequence,
    }).value;
}
/** Captures and validates the accepted lease before any execution capability is acquired. */
export function captureAcceptedCompactionInput(input) {
    if (!input || typeof input !== 'object')
        throw new AgentHostCompactionLeaseError('identity');
    const sourceLease = Reflect.get(input, 'lease');
    if (!sourceLease || typeof sourceLease !== 'object') {
        throw new AgentHostCompactionLeaseError('identity');
    }
    const lease = Object.freeze({
        sessionId: Reflect.get(sourceLease, 'sessionId'),
        turnId: Reflect.get(sourceLease, 'turnId'),
        leaseId: Reflect.get(sourceLease, 'leaseId'),
        busyReason: Reflect.get(sourceLease, 'busyReason'),
        acceptedSequence: Reflect.get(sourceLease, 'acceptedSequence'),
        acceptedAtMs: Reflect.get(sourceLease, 'acceptedAtMs'),
        signal: Reflect.get(sourceLease, 'signal'),
    });
    const reason = normalizeOptionalText(Reflect.get(input, 'reason'));
    const customInstructions = normalizeOptionalText(Reflect.get(input, 'customInstructions'));
    const captured = Object.freeze({
        lease,
        ...(reason ? { reason } : {}),
        ...(customInstructions ? { customInstructions } : {}),
    });
    validateCompactionInput(captured);
    return captured;
}
function validateCompactionInput(input) {
    const { lease } = input;
    if (!hasAcceptedLeaseIdentity(lease)) {
        throw new AgentHostCompactionLeaseError('identity');
    }
    if (lease.busyReason !== 'compaction') {
        throw new AgentHostCompactionLeaseError('busy-reason');
    }
    if (!Number.isFinite(lease.acceptedSequence) ||
        !Number.isSafeInteger(lease.acceptedSequence) ||
        lease.acceptedSequence <= 0) {
        throw new AgentHostCompactionLeaseError('sequence');
    }
    if (!Number.isSafeInteger(lease.acceptedAtMs) ||
        !Number.isFinite(lease.acceptedAtMs) ||
        lease.acceptedAtMs < 0) {
        throw new AgentHostCompactionLeaseError('accepted-at');
    }
    if (!isAbortSignalLike(lease.signal)) {
        throw new AgentHostCompactionLeaseError('signal');
    }
}
function normalizeOptionalText(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function validateHistory(history) {
    if (typeof history.revision !== 'string' ||
        !history.revision.trim() ||
        !Array.isArray(history.messages)) {
        throw new AgentCompactionSnapshotError('history');
    }
}
function abortReason(input) {
    return typeof input.lease.signal.reason === 'string' && input.lease.signal.reason.trim()
        ? input.lease.signal.reason.trim()
        : 'aborted';
}
function captureSession(expectedSessionId, session) {
    if (!session)
        throw new AgentCompactionSnapshotError('session');
    const snapshot = captureSemanticSnapshot(session).value;
    if (snapshot.sessionId !== expectedSessionId) {
        throw new AgentCompactionAssociationError('sessionId');
    }
    if (!isNonEmptyString(snapshot.agentName) ||
        !isNonEmptyString(snapshot.workspaceDir) ||
        (snapshot.sessionType !== 'root' && snapshot.sessionType !== 'branch')) {
        throw new AgentCompactionSnapshotError('session');
    }
    return snapshot;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
function abortError(signal) {
    return new Error(typeof signal.reason === 'string' && signal.reason.trim()
        ? signal.reason.trim()
        : 'Compaction aborted.');
}
async function capture(operation) {
    try {
        return { ok: true, value: await operation() };
    }
    catch (error) {
        return { ok: false, error };
    }
}
function captureSync(operation) {
    try {
        return { ok: true, value: operation() };
    }
    catch (error) {
        return { ok: false, error };
    }
}
function flattenFailure(error) {
    return error instanceof AggregateError ? error.errors.flatMap(flattenFailure) : [error];
}
function aggregateFailures(failures) {
    const unique = [...new Set(failures)];
    return unique.length === 1 ? unique[0] : new AggregateError(unique, 'Agent compaction failed.');
}
//# sourceMappingURL=agent-host-compaction-executor.js.map