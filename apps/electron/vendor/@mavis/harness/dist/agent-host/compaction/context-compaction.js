import { CONTEXT_USAGE_COMPONENT_KINDS, } from '@mavis/agent-core/protocol';
import { SEGMENT_COMPACTION_TIMEOUT } from './contracts.js';
import { readBackgroundSegment, readSegmentCheckpointPlan, segmentPlanFields, timeSegmentCompactionWait, } from './segment-checkpoint-plan.js';
import { copyCanonicalHistoryForPiCompatibility, validateCanonicalHistoryMessages, } from '../history/canonical-history-validation.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import { recordSharedPrefixFallbackBestEffort } from './checkpoint-request-shape.js';
import { recordCheckpointAttemptBestEffort } from './diagnostics/checkpoint-attempt.js';
import { logCheckpointGeneratedBestEffort } from './diagnostics/checkpoint-generated.js';
import { logCompactionFailureBestEffort } from './diagnostics/compaction-failure.js';
import { recordHistoryRepairBestEffort } from './diagnostics/history-repair.js';
import { compactionTokenUsageMetadata, createCompactionTokenUsageAccumulator, readCompactionTokenUsage, } from './token-usage.js';
export { createCompactionTokenUsageAccumulator, readCompactionTokenUsage } from './token-usage.js';
export { recordCheckpointAttemptBestEffort } from './diagnostics/checkpoint-attempt.js';
export { logCheckpointGeneratedBestEffort } from './diagnostics/checkpoint-generated.js';
export { logCompactionFailureBestEffort } from './diagnostics/compaction-failure.js';
export { recordHistoryRepairBestEffort } from './diagnostics/history-repair.js';
// Mark fire-and-forget deliveries as consumed without retaining a pending
// observer forever. `deliverObservation` catches both sync and async failures.
const nonAuthoritativeObservations = new WeakSet();
export class ContextCompactionResultValidationError extends Error {
    field;
    name = 'ContextCompactionResultValidationError';
    constructor(field) {
        super(`Context compaction result ${field} is invalid.`);
        this.field = field;
    }
}
class AutomaticContextCompactionDeferredError extends Error {
    name = 'AutomaticContextCompactionDeferredError';
}
class AutomaticContextCompactionHookAbortError extends Error {
    name = 'AutomaticContextCompactionHookAbortError';
}
export class ContextCompactionAttemptFactory {
    namespace;
    sequence = 0;
    create(context, leaseId, phase) {
        validateContextCompactionAttemptScope(context, leaseId, phase);
        this.namespace ??= createAttemptNamespace();
        return createContextCompactionAttemptId(this.namespace, ++this.sequence);
    }
}
/**
 * The default ladder's deadline when the segment profile handed over a
 * request it could not shrink in time; nothing left fails the Turn now.
 */
function fallbackDeadline(timeLimitMs) {
    if (timeLimitMs === undefined)
        return {};
    if (timeLimitMs <= 0)
        return { decision: { type: 'abort', reason: SEGMENT_COMPACTION_TIMEOUT } };
    return { deadline: AbortSignal.timeout(timeLimitMs) };
}
/**
 * Segment (Bunny) profile decision before an LLM request: continue, replace the
 * history with a rebuilt segment, stop the request, or hand over to the default
 * ladder after a failed rebuild or for a repeated request the provider rejected
 * (`input.recovery`), with a deadline when the request must wait.
 */
async function decideSegmentCompaction(plan) {
    const { input } = plan;
    const outcome = await plan.turn.beforeLlm(input, {
        onRebuildStarted: plan.startAttempt,
        // An emergency rebuild holds the history but is no compaction to show or admit.
        onEmergencyRebuildStarted: async () => {
            if (plan.attempt.started)
                return;
            await plan.barrier?.begin(plan.context.sessionId, plan.attemptId, plan.context.turnId);
            plan.attempt.started = true;
        },
        sharedPrefixAllowed: plan.sharedPrefixAllowed,
        ...(plan.backgroundRoute ? { backgroundRoute: plan.backgroundRoute } : {}),
    });
    if (outcome.kind === 'continue')
        return { decision: { type: 'continue' } };
    if (outcome.kind === 'fail')
        return { decision: { type: 'abort', reason: outcome.reason } };
    if (outcome.kind === 'default' && outcome.quiet)
        plan.attempt.quiet = true;
    if (outcome.kind === 'default')
        return fallbackDeadline(outcome.timeLimitMs);
    let result;
    try {
        result = captureContextCompactionResult(outcome.commit.result, input.canonicalMessages.length);
        if (result.status !== 'completed')
            throw new ContextCompactionResultValidationError('status');
    }
    catch (error) {
        // A hidden rebuild is the Turn's recovery: sending the request unchanged
        // would only repeat the failure it recovers from.
        if (!outcome.commit.result.segment.hidden)
            throw error;
        const reason = `segment_rebuild_invalid:${describeUnknownError(error)}`;
        return { decision: { type: 'abort', reason } };
    }
    plan.onReplace();
    return {
        decision: {
            type: 'replaceMessages',
            messages: copyCanonicalHistoryForPiCompatibility(result.replacementMessages),
            metadata: createCompactionReplaceMetadata(result, input.phase, plan.attemptId),
            afterCommit: async () => {
                try {
                    await outcome.commit.afterCommit();
                }
                catch {
                    // Post-commit bookkeeping never fails the Turn.
                }
                return undefined;
            },
        },
    };
}
export function createAutomaticContextCompactionHook(dependencies, context, leaseId, options = {}) {
    const attempts = options.attempts ?? new ContextCompactionAttemptFactory();
    const trustedContext = captureSemanticSnapshot(context).value;
    const decide = async (input, wait) => {
        const attemptId = attempts.create(trustedContext, leaseId, input.phase);
        const attemptState = { started: false, quiet: false };
        const providerTokenUsage = createCompactionTokenUsageAccumulator();
        let awaitingHistoryCommit = false;
        const startAttempt = async () => {
            if (attemptState.started)
                return;
            if (dependencies.barrier) {
                await dependencies.barrier.begin(trustedContext.sessionId, attemptId, trustedContext.turnId);
            }
            const admission = await options.beforeCompaction?.();
            if (admission === false)
                throw new AutomaticContextCompactionDeferredError();
            if (typeof admission === 'object' && admission.abort) {
                throw new AutomaticContextCompactionHookAbortError(admission.reason);
            }
            attemptState.started = true;
            wait.started = true;
            observeCompactionBestEffort(dependencies.observer, {
                context: trustedContext,
                attemptId,
                status: 'started',
                reason: 'automatic',
                ...(attemptState.quiet ? { display: false } : {}),
            });
        };
        // Set when the request cannot be sent as it is and the default ladder has a deadline.
        let deadline;
        try {
            const segment = options.segmentTurn
                ? await decideSegmentCompaction({
                    turn: options.segmentTurn,
                    input,
                    context: trustedContext,
                    attemptId,
                    barrier: dependencies.barrier,
                    startAttempt,
                    sharedPrefixAllowed: options.checkpointRequestShape === 'shared_prefix',
                    backgroundRoute: options.segmentRoute,
                    onReplace: () => {
                        awaitingHistoryCommit = true;
                        // The rebuilt segment keeps the anchored reply in its tail, so until
                        // the commit advances the history every later hook of this request
                        // would measure it as the pre-rebuild total plus that tail.
                        try {
                            dependencies.usageAnchor?.advanceHistory(trustedContext.sessionId);
                        }
                        catch {
                            // Process-local usage hints never change the replacement.
                        }
                    },
                    attempt: attemptState,
                })
                : {};
            if ('decision' in segment)
                return segment.decision;
            deadline = segment.deadline;
            const automaticInput = automaticContextCompactionInput(input, options, deadline);
            const probe = dependencies.automatic.probeBeforeLlm?.(automaticInput);
            if (probe?.shouldStart === false) {
                return resolveAutomaticCompactionResult({
                    dependencies,
                    context: trustedContext,
                    attemptId,
                    input,
                    messages: input.messages,
                    result: { status: 'unchanged', reason: 'nothing-to-compact' },
                });
            }
            const messages = captureSemanticSnapshot(input.messages).value;
            const result = captureContextCompactionResult(await dependencies.automatic.compactBeforeLlm({
                ...automaticInput,
                messages,
            }, {
                onStarted: startAttempt,
                onCheckpointGenerated: (metadata) => {
                    attemptState.checkpoint = logCheckpointGeneratedBestEffort(options.logger, {
                        context: trustedContext,
                        attemptId,
                        phase: input.phase,
                        thinkingLevel: input.thinkingLevel,
                        checkpoint: metadata,
                    });
                },
                onCheckpointAttemptSettled: (metadata) => recordCheckpointAttemptBestEffort(options.logger, dependencies.metricsClient, {
                    context: trustedContext,
                    attemptId,
                    phase: input.phase,
                    thinkingLevel: input.thinkingLevel,
                    checkpoint: metadata,
                }),
                onCheckpointSharedPrefixFallback: (reason) => recordSharedPrefixFallbackBestEffort(options.logger, dependencies.metricsClient, {
                    context: trustedContext,
                    attemptId,
                    phase: input.phase,
                    api: input.model.api,
                    reason,
                }),
                onHistoryRepaired: (repair) => recordHistoryRepairBestEffort(options.logger, dependencies.metricsClient, {
                    context: trustedContext,
                    attemptId,
                    phase: input.phase,
                    repair,
                }),
                onProviderRequestSettled: providerTokenUsage.observe,
                getProviderTokenUsage: providerTokenUsage.snapshot,
            }), messages.length);
            const decision = resolveAutomaticCompactionResult({
                dependencies,
                context: trustedContext,
                attemptId,
                input,
                messages,
                result,
            });
            awaitingHistoryCommit = decision.type === 'replaceMessages';
            return decision;
        }
        catch (error) {
            if (error instanceof AutomaticContextCompactionDeferredError) {
                return { type: 'skip', reason: 'context_compaction_deferred_by_plugin_hook' };
            }
            if (error instanceof AutomaticContextCompactionHookAbortError) {
                return { type: 'abort', reason: error.message };
            }
            if (!attemptState.started && input.signal?.aborted) {
                return { type: 'skip', reason: 'context_compaction_aborted_before_start' };
            }
            const timedOut = ranOutOfTime(deadline, input.signal);
            logCompactionFailureBestEffort(options.logger, {
                context: trustedContext,
                attemptId,
                phase: input.phase,
                thinkingLevel: input.thinkingLevel,
                checkpoint: attemptState.checkpoint,
                error,
            });
            const lifecycle = await captureFailure(() => dependencies.lifecycle.failCommittedHistory({
                context: trustedContext,
                attemptId,
                error,
                ...(attemptState.quiet ? { display: false } : {}),
            }));
            observeCompactionBestEffort(dependencies.observer, {
                context: trustedContext,
                attemptId,
                status: compactionFailureStatus(input.signal, attemptState.checkpoint),
                reason: describeUnknownError(error),
                ...compactionTokenUsageMetadata(providerTokenUsage.snapshot()),
            });
            return failedCompactionDecision(timedOut, lifecycle.failed);
        }
        finally {
            endAutomaticCompactionBarrier(dependencies.barrier, trustedContext, attemptId, awaitingHistoryCommit);
        }
    };
    if (!options.segmentTurn)
        return (input) => decide(input, { started: false });
    // A segment (Bunny) Turn: how long the request was held for a compaction it had to wait for.
    return timeSegmentCompactionWait(dependencies.metricsClient, decide);
}
/** The default ladder ran past its deadline, not into the user's stop. */
function ranOutOfTime(deadline, signal) {
    return deadline?.aborted === true && signal?.aborted !== true;
}
function failedCompactionDecision(timedOut, recordFailed) {
    // A request over the input limit whose compaction ran out of time
    // cannot be sent; the Turn fails with a reason the Desktop explains.
    if (timedOut)
        return { type: 'abort', reason: SEGMENT_COMPACTION_TIMEOUT };
    // Automatic compaction is optional maintenance and always fails open:
    // the parent Turn continues with pre-compaction history to the payload
    // transform. Final byte admission runs there after Files API conversion;
    // a pre-transform footprint must not reject a compact file reference.
    // This also applies to POST_ADMISSION_FAILED.
    return {
        type: 'skip',
        reason: recordFailed ? 'context_compaction_failure_record_failed' : 'context_compaction_failed',
    };
}
function endAutomaticCompactionBarrier(barrier, context, attemptId, awaitingHistoryCommit) {
    if (!awaitingHistoryCommit)
        barrier?.end(context.sessionId, attemptId);
}
function automaticContextCompactionInput(input, options, deadline) {
    const { maxSerializedInputBytes, checkpointRequestShape } = options;
    const signal = deadline && input.signal
        ? AbortSignal.any([input.signal, deadline])
        : (deadline ?? input.signal);
    return {
        sessionId: input.sessionId,
        phase: input.phase,
        ...(input.recovery ? { recovery: input.recovery } : {}),
        messages: input.messages,
        model: input.model,
        ...(maxSerializedInputBytes === undefined ? {} : { maxSerializedInputBytes }),
        ...(checkpointRequestShape === 'shared_prefix' ? { checkpointRequestShape } : {}),
        streamFn: input.streamFn,
        apiKey: input.apiKey,
        headers: input.headers,
        maxTokens: input.maxTokens,
        cacheRetention: input.cacheRetention,
        payloadTransform: input.auxiliaryPayloadTransform ?? input.payloadTransform,
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        thinkingLevel: input.thinkingLevel,
        signal,
    };
}
function compactionFailureStatus(signal, checkpoint) {
    return signal?.aborted || checkpoint?.stopReason === 'aborted' ? 'aborted' : 'failed';
}
function resolveAutomaticCompactionResult(plan) {
    const { dependencies, context, attemptId, input, result } = plan;
    if (result.status === 'unchanged') {
        observeCompactionBestEffort(dependencies.observer, {
            context,
            attemptId,
            status: 'unchanged',
            reason: result.reason,
        });
        return { type: 'continue' };
    }
    if (result.status === 'replaced') {
        observeCompactionBestEffort(dependencies.observer, {
            context,
            attemptId,
            status: 'unchanged',
            reason: result.reason,
        });
        return {
            type: 'replaceRequestMessages',
            messages: copyCanonicalHistoryForPiCompatibility(result.replacementMessages),
            reason: result.reason,
        };
    }
    return {
        type: 'replaceMessages',
        messages: copyCanonicalHistoryForPiCompatibility(result.replacementMessages),
        metadata: createCompactionReplaceMetadata(result, input.phase, attemptId),
    };
}
export function captureContextCompactionResult(result, expectedMessagesBefore) {
    const snapshot = captureSemanticSnapshot(result).value;
    if (snapshot.status === 'unchanged') {
        if (snapshot.reason !== 'nothing-to-compact') {
            throw new ContextCompactionResultValidationError('reason');
        }
        return snapshot;
    }
    if (snapshot.status === 'replaced') {
        if (snapshot.reason !== 'internal-context-filter') {
            throw new ContextCompactionResultValidationError('reason');
        }
        const replacementId = normalizeIdentity(snapshot.replacementId, 'replacementId');
        const strategyVersion = normalizeIdentity(snapshot.strategyVersion, 'strategyVersion');
        validateReplacement(snapshot, expectedMessagesBefore);
        return captureSemanticSnapshot({
            ...snapshot,
            replacementId,
            strategyVersion,
        }).value;
    }
    if (snapshot.status !== 'completed') {
        throw new ContextCompactionResultValidationError('status');
    }
    const compactionId = normalizeIdentity(snapshot.compactionId, 'compactionId');
    const strategyVersion = normalizeIdentity(snapshot.strategyVersion, 'strategyVersion');
    validateCompletedCompaction(snapshot, expectedMessagesBefore);
    const { contextUsage: rawContextUsage, tokenUsage: rawTokenUsage, ...completed } = snapshot;
    const contextUsage = readPostCompactionContextUsage(rawContextUsage);
    const tokenUsage = readCompactionTokenUsage(rawTokenUsage);
    return captureSemanticSnapshot({
        ...completed,
        compactionId,
        strategyVersion,
        ...(contextUsage === undefined ? {} : { contextUsage }),
        ...compactionTokenUsageMetadata(tokenUsage),
    }).value;
}
function validateCompletedCompaction(snapshot, expectedMessagesBefore) {
    if (snapshot.method !== 'llm_checkpoint' && snapshot.method !== 'llm_segment_checkpoint') {
        throw new ContextCompactionResultValidationError('method');
    }
    if (typeof snapshot.summary !== 'string') {
        throw new ContextCompactionResultValidationError('summary');
    }
    validateHmidOverflowRecovery(snapshot);
    validateCompletedTokenUsage(snapshot);
    validateReplacement(snapshot, expectedMessagesBefore);
    if (snapshot.method === 'llm_segment_checkpoint')
        validateSegmentPlan(snapshot);
    validateCounts(snapshot, [
        'tokensBefore',
        'tokensAfter',
        'serializedBytesBefore',
        'serializedBytesAfter',
    ]);
}
function validateSegmentPlan(result) {
    if (readSegmentCheckpointPlan(segmentPlanFields(result.segment), result.messagesAfter))
        return;
    throw new ContextCompactionResultValidationError('segment');
}
function validateCompletedTokenUsage(snapshot) {
    if (Object.hasOwn(snapshot, 'tokenUsage') &&
        readCompactionTokenUsage(snapshot.tokenUsage) === undefined) {
        throw new ContextCompactionResultValidationError('tokenUsage');
    }
}
function validateHmidOverflowRecovery(snapshot) {
    if (!Object.hasOwn(snapshot, 'hmidOverflowRecovered'))
        return;
    if (snapshot.hmidOverflowRecovered === true)
        return;
    throw new ContextCompactionResultValidationError('hmidOverflowRecovered');
}
export function createCompactionReplaceMetadata(result, phase, attemptId) {
    const contextUsage = readPostCompactionContextUsage(result.contextUsage);
    const tokenUsage = readCompactionTokenUsage(result.tokenUsage);
    return captureSemanticSnapshot({
        compactionAttemptId: attemptId,
        replacementId: result.compactionId,
        strategyVersion: result.strategyVersion,
        compactionMethod: result.method,
        summary: '',
        compactedMessages: [],
        keptMessages: [],
        firstKeptIndex: 0,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        serializedBytesBefore: result.serializedBytesBefore,
        serializedBytesAfter: result.serializedBytesAfter,
        messagesBefore: result.messagesBefore,
        messagesAfter: result.messagesAfter,
        ...(result.tokensBeforeSource === undefined
            ? {}
            : { tokensBeforeSource: result.tokensBeforeSource }),
        compactionPhase: phase,
        ...(result.hmidOverflowRecovered ? { hmidOverflowRecovered: true } : {}),
        ...(result.method === 'llm_segment_checkpoint' ? segmentPlanFields(result.segment) : {}),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        ...compactionTokenUsageMetadata(tokenUsage),
    }).value;
}
function validateReplacement(result, expectedMessagesBefore) {
    if (!Array.isArray(result.replacementMessages)) {
        throw new ContextCompactionResultValidationError('replacementMessages');
    }
    validateCanonicalHistoryMessages(result.replacementMessages);
    validateCounts(result, ['messagesBefore', 'messagesAfter']);
    if ((expectedMessagesBefore !== undefined && result.messagesBefore !== expectedMessagesBefore) ||
        result.messagesAfter !== result.replacementMessages.length) {
        throw new ContextCompactionResultValidationError('messageCounts');
    }
}
function validateCounts(result, fields) {
    fields.forEach((field) => {
        const value = Reflect.get(result, field);
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
            throw new ContextCompactionResultValidationError(field);
        }
    });
}
export function readCompactionLifecycleMetadata(value) {
    if (!isRecord(value))
        return undefined;
    const attemptId = readCompactionAttemptId(value);
    const compactionId = readNonEmpty(value, 'replacementId');
    const strategyVersion = readNonEmpty(value, 'strategyVersion');
    const method = readCompactionMethod(Reflect.get(value, 'compactionMethod'));
    const phase = Reflect.get(value, 'compactionPhase');
    if (!attemptId || !compactionId || !strategyVersion || !method || !isCompactionPhase(phase)) {
        return undefined;
    }
    const counts = readCompactionLifecycleCounts(value);
    const contextUsage = readPostCompactionContextUsage(Reflect.get(value, 'contextUsage'));
    const tokenUsage = readCompactionTokenUsage(Reflect.get(value, 'tokenUsage'));
    if (!counts)
        return undefined;
    return Object.freeze({
        attemptId,
        compactionId,
        method,
        strategyVersion,
        phase,
        ...counts,
        ...tokensBeforeSourceMetadata(Reflect.get(value, 'tokensBeforeSource')),
        ...(Reflect.get(value, 'hmidOverflowRecovered') === true
            ? { hmidOverflowRecovered: true }
            : {}),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        ...compactionTokenUsageMetadata(tokenUsage),
        ...readBackgroundSegment(value, method),
    });
}
function readCompactionLifecycleCounts(value) {
    const messagesBefore = readCount(value, 'messagesBefore');
    const messagesAfter = readCount(value, 'messagesAfter');
    const tokensBefore = readCount(value, 'tokensBefore');
    const tokensAfter = readCount(value, 'tokensAfter');
    const serializedBytesBefore = readCount(value, 'serializedBytesBefore');
    const serializedBytesAfter = readCount(value, 'serializedBytesAfter');
    return messagesBefore !== undefined &&
        messagesAfter !== undefined &&
        tokensBefore !== undefined &&
        tokensAfter !== undefined &&
        serializedBytesBefore !== undefined &&
        serializedBytesAfter !== undefined
        ? {
            messagesBefore,
            messagesAfter,
            tokensBefore,
            tokensAfter,
            serializedBytesBefore,
            serializedBytesAfter,
        }
        : undefined;
}
/** Anything else, including absence, reads as "unknown" rather than a guessed source. */
function readContextFootprintSource(value) {
    return value === 'provider_anchor' || value === 'local_estimate' ? value : undefined;
}
/** Keeps the optional-field spread out of the lifecycle reader's complexity budget. */
function tokensBeforeSourceMetadata(value) {
    const source = readContextFootprintSource(value);
    return source === undefined ? {} : { tokensBeforeSource: source };
}
function readCompactionMethod(value) {
    return value === 'llm_checkpoint' || value === 'llm_segment_checkpoint' ? value : undefined;
}
export function readPostCompactionContextUsage(value) {
    if (!isRecord(value) || Reflect.get(value, 'totalCountSource') !== 'LOCAL_ESTIMATE') {
        return undefined;
    }
    const contextWindowTokens = readPositiveTokenEstimate(value, 'contextWindowTokens');
    const usedTokens = readTokenEstimate(value, 'usedTokens');
    const rawComponents = Reflect.get(value, 'components');
    if (contextWindowTokens === undefined ||
        usedTokens === undefined ||
        !Array.isArray(rawComponents) ||
        rawComponents.length !== CONTEXT_USAGE_COMPONENT_KINDS.length) {
        return undefined;
    }
    const components = rawComponents.flatMap((component, index) => {
        if (!isRecord(component))
            return [];
        const expectedKind = CONTEXT_USAGE_COMPONENT_KINDS[index];
        const tokens = readTokenEstimate(component, 'tokens');
        return expectedKind !== undefined &&
            Reflect.get(component, 'kind') === expectedKind &&
            tokens !== undefined
            ? [{ kind: expectedKind, tokens }]
            : [];
    });
    if (components.length !== CONTEXT_USAGE_COMPONENT_KINDS.length ||
        !tokenEstimatesMatch(components.reduce((sum, component) => sum + component.tokens, 0), usedTokens)) {
        return undefined;
    }
    return {
        contextWindowTokens,
        usedTokens,
        totalCountSource: 'LOCAL_ESTIMATE',
        components,
    };
}
export function readCompactionAttemptId(value) {
    return isRecord(value) ? readNonEmpty(value, 'compactionAttemptId') : undefined;
}
function createContextCompactionAttemptId(namespace, sequence) {
    return JSON.stringify(['agent-host-context-compaction', namespace, sequence]);
}
function validateContextCompactionAttemptScope(context, leaseId, phase) {
    assertAttemptIdentity(context.sessionId);
    assertAttemptIdentity(context.turnId);
    assertAttemptIdentity(leaseId);
    assertAttemptSequence(context.turnSequence);
    if (!isCompactionPhase(phase)) {
        throw new ContextCompactionResultValidationError('attemptId');
    }
}
function assertAttemptIdentity(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ContextCompactionResultValidationError('attemptId');
    }
}
function assertAttemptSequence(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ContextCompactionResultValidationError('attemptId');
    }
}
function createAttemptNamespace() {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID !== 'function') {
        throw new ContextCompactionResultValidationError('attemptId');
    }
    return Reflect.apply(randomUUID, globalThis.crypto, []);
}
export function observeCompactionBestEffort(observer, fact) {
    if (!observer)
        return;
    try {
        const detached = captureSemanticSnapshot(fact).value;
        nonAuthoritativeObservations.add(deliverObservation(observer, detached));
    }
    catch {
        // Live/UI observation is explicitly outside the authoritative outcome.
    }
}
async function deliverObservation(observer, fact) {
    try {
        await observer.observe(fact);
    }
    catch {
        // Live/UI observation is explicitly outside the authoritative outcome.
    }
}
export function describeUnknownError(error) {
    if (error instanceof Error)
        return error.message;
    if (typeof error === 'string')
        return error;
    try {
        return String(error);
    }
    catch {
        return 'unknown error';
    }
}
async function captureFailure(operation) {
    try {
        await operation();
        return { failed: false };
    }
    catch (error) {
        return { failed: true, error };
    }
}
function normalizeIdentity(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new ContextCompactionResultValidationError(field);
    }
    const normalized = value.trim();
    try {
        encodeURIComponent(normalized);
    }
    catch {
        throw new ContextCompactionResultValidationError(field);
    }
    return normalized;
}
function readNonEmpty(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'string' && field.trim() ? field.trim() : undefined;
}
function readCount(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'number' && Number.isSafeInteger(field) && field >= 0 ? field : undefined;
}
function readTokenEstimate(value, key) {
    const field = Reflect.get(value, key);
    return typeof field === 'number' && Number.isFinite(field) && field >= 0 ? field : undefined;
}
function readPositiveTokenEstimate(value, key) {
    const field = readTokenEstimate(value, key);
    return field !== undefined && field > 0 ? field : undefined;
}
function tokenEstimatesMatch(left, right) {
    const tolerance = Number.EPSILON *
        Math.max(1, Math.abs(left), Math.abs(right)) *
        CONTEXT_USAGE_COMPONENT_KINDS.length;
    return Math.abs(left - right) <= tolerance;
}
function isCompactionPhase(value) {
    return value === 'initial' || value === 'iteration' || value === 'manual';
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=context-compaction.js.map