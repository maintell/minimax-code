import { observeCompactionBestEffort, readCompactionAttemptId, readCompactionLifecycleMetadata, } from '../compaction/context-compaction.js';
import { endToolSearchWindow, forgetToolSearchAnnouncements } from '../tools/tool-search.js';
import { endSkillCatalogWindow, forgetSkillCatalogAnnouncements, } from '../tools/skill-catalog-window.js';
import { AgentHostDependencyUnavailableError } from '../empty-dependencies.js';
import { SemanticReplayRegistry } from '../events/semantic-replay-registry.js';
import { resetPromptSectionBaseline } from '../runner/observability/prompt-section-change.js';
import { captureSemanticSnapshot, estimateSemanticValueSize } from './semantic-identity.js';
const DEFAULT_COMMITTED_HISTORY_REPLAYS = 2_048;
const DEFAULT_COMMITTED_HISTORY_REPLAY_BYTES = 64 * 1_024 * 1_024;
class AgentCommittedHistoryIdentityError extends Error {
    reason;
    operationId;
    name = 'AgentCommittedHistoryIdentityError';
    constructor(reason, operationId) {
        super(`Committed history ${reason}: "${operationId}".`);
        this.reason = reason;
        this.operationId = operationId;
    }
}
/**
 * The history refused a segment plan before writing anything, because the
 * segment or its covered prefix changed since the plan was made.
 */
export class SegmentPlanRefusedError extends Error {
    name = 'SegmentPlanRefusedError';
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
}
/**
 * A hidden segment rebuild whose write failed and left the history as it was:
 * the rebuild was not made. The failure is the rebuild's own, not the
 * Session's history, so the Turn's later records and events still commit.
 */
export class UnmadeSegmentRebuildError extends Error {
    name = 'UnmadeSegmentRebuildError';
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
}
/**
 * Single Host-internal canonical commit path for normal, automatic-compaction,
 * manual-compaction and reconcile changes.
 *
 * The CanonicalHistoryStore returns the durable mutation's full reread from
 * the same per-Session lane. Required HistoryCommitted projection and
 * compaction lifecycle completion gate the returned acknowledgement; live
 * observation never does.
 */
export class AgentHostCommittedHistoryWriter {
    dependencies;
    replay;
    usageObservations = new WeakSet();
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.replay = new SemanticReplayRegistry(DEFAULT_COMMITTED_HISTORY_REPLAYS, {
            maximumSettledBytes: dependencies.maxRetainedReplayBytes ?? DEFAULT_COMMITTED_HISTORY_REPLAY_BYTES,
            measureSettledBytes: estimateSemanticValueSize,
        });
    }
    async commit(context, change, options = {}) {
        const explicitAttemptId = normalizeAttemptId(options.compactionAttemptId);
        const trustedContext = captureSemanticSnapshot(context).value;
        let snapshot;
        try {
            snapshot = captureSemanticSnapshot({
                context: trustedContext,
                change: withoutTerminalAssistantError(change),
            });
        }
        catch (error) {
            return this.failCompactionAttempt(trustedContext, explicitAttemptId, error);
        }
        const metadata = readCompactionLifecycleMetadata(snapshot.value.change.metadata);
        const metadataAttemptId = readCompactionAttemptId(snapshot.value.change.metadata);
        const attemptId = explicitAttemptId ?? metadataAttemptId;
        try {
            validatePreparedChange({
                context: snapshot.value.context,
                change: snapshot.value.change,
                explicitAttemptId,
                metadataAttemptId,
                metadata,
            });
        }
        catch (error) {
            return this.failCompactionAttempt(snapshot.value.context, attemptId, error, metadata);
        }
        const operationId = snapshot.value.change.operation.id;
        let compaction;
        try {
            compaction = metadata ? this.requireCompactionLifecycle() : undefined;
        }
        catch (error) {
            return Promise.reject(error);
        }
        try {
            return await this.replay.run({
                identity: JSON.stringify([snapshot.value.context.sessionId, operationId]),
                fingerprint: snapshot.fingerprint,
                execute: () => this.commitSnapshot({
                    context: snapshot.value.context,
                    change: snapshot.value.change,
                    metadata,
                    compaction,
                    ...(options.onDurableCommitted
                        ? { onDurableCommitted: options.onDurableCommitted }
                        : {}),
                    ...(options.baseIdentity ? { baseIdentity: options.baseIdentity } : {}),
                }),
                conflict: () => new AgentCommittedHistoryIdentityError('conflict', operationId),
                handleConflict: (error) => this.failCommit({
                    context: snapshot.value.context,
                    change: snapshot.value.change,
                    error,
                    metadata,
                    compaction,
                }),
            });
        }
        finally {
            if (attemptId && metadata?.phase !== 'manual') {
                this.dependencies.compaction?.barrier?.end(trustedContext.sessionId, attemptId);
            }
        }
    }
    commitTurnMutation(context, mutation, options = {}) {
        let snapshot;
        try {
            const trustedContext = captureSemanticSnapshot(context).value;
            const change = turnMutationChange(mutation);
            snapshot = captureSemanticSnapshot({ context: trustedContext, mutation, change });
            validateTurnMutation(snapshot.value.context, snapshot.value.mutation);
            validateChange(snapshot.value.context, snapshot.value.change);
        }
        catch (error) {
            return Promise.reject(error);
        }
        const operationId = snapshot.value.mutation.operation.id;
        return this.replay.run({
            identity: JSON.stringify([snapshot.value.context.sessionId, operationId]),
            fingerprint: snapshot.fingerprint,
            execute: () => this.commitTurnMutationSnapshot({
                ...snapshot.value,
                ...(options.onDurableCommitted ? { onDurableCommitted: options.onDurableCommitted } : {}),
            }),
            conflict: () => new AgentCommittedHistoryIdentityError('conflict', operationId),
        });
    }
    async readSettled(sessionId) {
        const snapshot = captureSemanticSnapshot(await this.dependencies.history.read(sessionId)).value;
        validateCommittedSnapshot(snapshot, 'settled-read');
        return snapshot;
    }
    async commitSnapshot(plan) {
        const { context, change, metadata, compaction, onDurableCommitted } = plan;
        try {
            const committed = captureSemanticSnapshot(await this.commitCanonical(change)).value;
            validateCommittedSnapshot(committed, change.operation.id);
            const delivered = captureSemanticSnapshot({
                ...change,
                committedRevision: committed.revision.trim(),
                committedMessages: committed.messages,
                ...(committed.identityVector ? { committedIdentityVector: committed.identityVector } : {}),
            }).value;
            this.updateUsageAnchor(context, delivered);
            onDurableCommitted?.(delivered);
            // The replacement history is durable from here on, whatever the steps
            // below do: the model lost the old Skill bodies the moment the write
            // landed, so the receipt clear must not wait for event delivery.
            if (metadata && compaction)
                this.notifyCompactionCommitted(context.sessionId, delivered);
            await this.dependencies.events.handleHistoryCommitted(context, delivered);
            this.observeUsage(context, delivered);
            await this.completeCompaction(context, delivered, metadata, compaction);
            return delivered;
        }
        catch (error) {
            const unmade = (await this.leftUnchanged(plan, error)) ? { unmade: true } : {};
            return this.failCommit({ context, change, error, metadata, compaction, ...unmade });
        }
    }
    /**
     * A hidden segment rebuild that wrote nothing: the history refused its plan
     * (another change came first), or failed with the history still at its base.
     */
    async leftUnchanged(plan, error) {
        if (plan.metadata?.hidden !== true)
            return false;
        if (error instanceof SegmentPlanRefusedError)
            return true;
        const base = plan.baseIdentity;
        if (!base)
            return false;
        try {
            const settled = await this.readSettled(plan.context.sessionId);
            const identity = settled.identityVector ?? [];
            return identity.length === base.length && identity.every((id, index) => id === base[index]);
        }
        catch {
            return false;
        }
    }
    async commitTurnMutationSnapshot(plan) {
        const { context, mutation, change, onDurableCommitted } = plan;
        // AgentHost classifies semantic mutation failures: abort/network may
        // recover after a strict settled read, while Safety remains fail-closed.
        // Do not eagerly project a generic permanent Session history failure here.
        const committed = captureSemanticSnapshot(await this.commitCanonicalTurnMutation(mutation)).value;
        validateCommittedSnapshot(committed, change.operation.id);
        const delivered = captureSemanticSnapshot({
            ...change,
            messages: committed.messages,
            committedRevision: committed.revision.trim(),
            committedMessages: committed.messages,
            ...(committed.identityVector ? { committedIdentityVector: committed.identityVector } : {}),
        }).value;
        this.updateUsageAnchor(context, delivered);
        onDurableCommitted?.(delivered);
        await this.dependencies.events.handleHistoryCommitted(context, delivered);
        return delivered;
    }
    updateUsageAnchor(context, change) {
        try {
            const anchor = this.dependencies.compaction?.usageAnchor;
            if (!anchor)
                return;
            if (change.reason === 'messageDelta') {
                anchor.recordBound(context.sessionId, change.messages);
            }
            else {
                anchor.advanceHistory(context.sessionId);
            }
        }
        catch {
            // Process-local trigger hints cannot affect durable History acknowledgement.
        }
    }
    commitCanonical(change) {
        if (change.reason === 'messageDelta')
            return this.dependencies.history.append(change);
        if (change.operation.kind === 'compaction') {
            if (!this.dependencies.history.compact) {
                throw new Error('Typed canonical compaction is unavailable.');
            }
            return this.dependencies.history.compact(asCompactionChange(change));
        }
        return this.dependencies.history.replace(change);
    }
    async commitCanonicalTurnMutation(mutation) {
        if (mutation.kind === 'settle-turn-tail') {
            if (!this.dependencies.history.settleTurnTail) {
                throw new AgentHostDependencyUnavailableError('history-settle-turn-tail');
            }
            return this.dependencies.history.settleTurnTail(mutation);
        }
        if (!this.dependencies.history.retractTurn) {
            throw new AgentHostDependencyUnavailableError('history-retract-turn');
        }
        const commit = await this.dependencies.history.retractTurn(mutation);
        // The retracted user message may have carried a Tool Search or skill availability
        // update: state them all again.
        forgetToolSearchAnnouncements(mutation.sessionId);
        forgetSkillCatalogAnnouncements(mutation.sessionId);
        return commit;
    }
    observeUsage(context, change) {
        const usage = this.dependencies.usage;
        if (change.reason !== 'messageDelta' || !usage)
            return;
        const observation = this.runUsageProjection(usage, context, change);
        this.usageObservations.add(observation);
    }
    async runUsageProjection(usage, context, change) {
        try {
            await usage.projector.record({
                sessionId: context.sessionId,
                turnId: context.turnId,
                model: context.executionModel,
                messages: [...change.messages],
            });
        }
        catch (error) {
            try {
                usage.onFailure?.({
                    sessionId: context.sessionId,
                    turnId: context.turnId,
                    error,
                });
            }
            catch {
                // Best-effort analytics diagnostics cannot escape into History acknowledgement.
            }
        }
    }
    async completeCompaction(context, delivered, metadata, compaction) {
        if (!metadata || !compaction)
            return;
        // The replacement history is durable: the next Turn may assemble a new prefix.
        this.dependencies.ptcPrefixBaselines?.reset(context.sessionId);
        resetPromptSectionBaseline(context.sessionId);
        // Same point for the Tool Search and skill catalog windows, so the next Turn plans afresh.
        endToolSearchWindow(context.sessionId);
        endSkillCatalogWindow(context.sessionId);
        await compaction.lifecycle.completeCommittedHistory({
            context,
            attemptId: metadata.attemptId,
            operationId: delivered.operation.id,
            committedRevision: delivered.committedRevision,
            metadata,
        });
        observeCompactionBestEffort(compaction.observer, {
            context,
            attemptId: metadata.attemptId,
            status: 'completed',
            compactionId: metadata.compactionId,
            messagesBefore: metadata.messagesBefore,
            messagesAfter: metadata.messagesAfter,
            tokensBefore: metadata.tokensBefore,
            tokensAfter: metadata.tokensAfter,
            ...(metadata.tokensBeforeSource === undefined
                ? {}
                : { tokensBeforeSource: metadata.tokensBeforeSource }),
            ...(metadata.contextUsage === undefined ? {} : { contextUsage: metadata.contextUsage }),
            ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
        });
    }
    /**
     * Both compaction effects the writer does not own, told once the replacement
     * history is durable. Best-effort: a failing observer or receipt clear never
     * turns a durable commit into a failure.
     */
    notifyCompactionCommitted(sessionId, change) {
        try {
            this.dependencies.onCompactionCommitted?.(sessionId, change.committedMessages);
        }
        catch {
            // Receipt bookkeeping cannot affect durable History acknowledgement.
        }
    }
    async failCommit(plan) {
        const { context, change, error, metadata, compaction, unmade } = plan;
        const failures = [...flattenFailure(error)];
        if (!unmade) {
            await appendCapturedFailure(failures, () => this.dependencies.historyFailure?.fail({
                sessionId: context.sessionId,
                turnId: context.turnId,
                ...(change.metadata === undefined ? {} : { metadata: change.metadata }),
            }));
        }
        if (metadata && compaction) {
            await appendCapturedFailure(failures, () => compaction.lifecycle.failCommittedHistory({
                context,
                attemptId: metadata.attemptId,
                error,
                metadata,
            }));
            observeCompactionBestEffort(compaction.observer, {
                context,
                attemptId: metadata.attemptId,
                status: 'failed',
                compactionId: metadata.compactionId,
                ...(metadata.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
            });
        }
        if (unmade && failures.length === flattenFailure(error).length) {
            throw new UnmadeSegmentRebuildError(error);
        }
        throwFailures(failures, 'Committed history mutation failed.');
    }
    async failCompactionAttempt(context, attemptId, error, metadata) {
        if (!attemptId)
            throw error;
        const compaction = this.requireCompactionLifecycle();
        const failures = [...flattenFailure(error)];
        await appendCapturedFailure(failures, () => this.dependencies.historyFailure?.fail({
            sessionId: context.sessionId,
            turnId: context.turnId,
            metadata: Object.freeze({ compactionAttemptId: attemptId }),
        }));
        await appendCapturedFailure(failures, () => compaction.lifecycle.failCommittedHistory({
            context,
            attemptId,
            error,
            ...(metadata ? { metadata } : {}),
        }));
        observeCompactionBestEffort(compaction.observer, {
            context,
            attemptId,
            status: 'failed',
            ...(metadata ? { compactionId: metadata.compactionId } : {}),
            ...(metadata?.tokenUsage === undefined ? {} : { tokenUsage: metadata.tokenUsage }),
        });
        throwFailures(failures, 'Committed history validation failed.');
    }
    requireCompactionLifecycle() {
        const compaction = this.dependencies.compaction;
        if (!compaction)
            throw new AgentHostDependencyUnavailableError('compaction-lifecycle');
        return compaction;
    }
}
function turnMutationChange(mutation) {
    return {
        sessionId: mutation.sessionId,
        turnId: mutation.turnId,
        reason: 'replaceMessages',
        messages: [],
        operation: mutation.operation,
    };
}
function validateTurnMutation(context, mutation) {
    if (mutation.sessionId !== context.sessionId ||
        mutation.turnId !== context.turnId ||
        !mutation.operation.id.trim()) {
        throw new AgentCommittedHistoryIdentityError('association', mutation.operation.id);
    }
}
/**
 * Drops terminal provider-error assistants from a delta. Their identity hints
 * go with them and later hints move to the kept messages' new indexes, so an
 * aligned Display id never points past the stored messages.
 */
function withoutTerminalAssistantError(change) {
    if (change.reason !== 'messageDelta')
        return change;
    const keptIndexes = new Map();
    const messages = change.messages.filter((message, index) => {
        if (isTerminalAssistantError(message))
            return false;
        keptIndexes.set(index, keptIndexes.size);
        return true;
    });
    if (messages.length === change.messages.length)
        return change;
    const { identityHints, ...rest } = change;
    const hints = identityHints?.flatMap((hint) => {
        const index = keptIndexes.get(hint.index);
        return index === undefined ? [] : [{ ...hint, index }];
    });
    return { ...rest, messages, ...(hints?.length ? { identityHints: hints } : {}) };
}
function isTerminalAssistantError(message) {
    return (typeof message === 'object' &&
        message !== null &&
        !Array.isArray(message) &&
        Reflect.get(message, 'role') === 'assistant' &&
        Reflect.get(message, 'stopReason') === 'error');
}
function normalizeAttemptId(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function validatePreparedChange(plan) {
    const { context, change, explicitAttemptId, metadataAttemptId, metadata } = plan;
    validateChange(context, change);
    if (explicitAttemptId && metadataAttemptId && explicitAttemptId !== metadataAttemptId) {
        throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
    }
    if (change.operation.kind === 'compaction' && !metadata) {
        throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
    }
}
function validateChange(context, change) {
    if (change.sessionId !== context.sessionId || change.turnId !== context.turnId) {
        throw new AgentCommittedHistoryIdentityError('association', change.operation.id);
    }
    if (!change.operation.id.trim()) {
        throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
    }
    const append = change.reason === 'messageDelta';
    if (append !== (change.operation.kind === 'append')) {
        throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
    }
}
function asCompactionChange(change) {
    if (change.reason !== 'replaceMessages' || change.operation.kind !== 'compaction') {
        throw new AgentCommittedHistoryIdentityError('identity', change.operation.id);
    }
    return {
        ...change,
        reason: 'replaceMessages',
        operation: { ...change.operation, kind: 'compaction' },
    };
}
function validateCommittedSnapshot(snapshot, operationId) {
    if (typeof snapshot.revision !== 'string' || !snapshot.revision.trim()) {
        throw new AgentCommittedHistoryIdentityError('revision', operationId);
    }
    if (!Array.isArray(snapshot.messages)) {
        throw new AgentCommittedHistoryIdentityError('messages', operationId);
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
async function appendCapturedFailure(failures, operation) {
    const captured = await captureFailure(operation);
    if (captured.failed)
        failures.push(...flattenFailure(captured.error));
}
function flattenFailure(error) {
    if (!(error instanceof AggregateError))
        return [error];
    return error.errors.flatMap((nested) => flattenFailure(nested));
}
function throwFailures(failures, message) {
    const unique = [...new Set(failures)];
    const first = unique.at(0);
    if (unique.length < 2)
        throw first;
    throw new AggregateError(unique, message);
}
//# sourceMappingURL=committed-history-writer.js.map