import { RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { readCompactionAttemptId, readCompactionLifecycleMetadata, } from '../compaction/context-compaction.js';
import { buildHostFailedEvent } from './host-failed-event.js';
import { AgentHistoryOperationIdentityError, AgentHistoryOperationReplayCoordinator, } from '../history/history-operation-replay.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import { TurnCommittedHistoryState } from '../history/turn-committed-history-state.js';
import { CanonicalUserMessageIdentityLane } from '../history/canonical-user-message-identities.js';
import { AgentEventAssociationError } from '../preparation/turn-preflight.js';
export class AgentTerminalConfirmationError extends Error {
    reason;
    expected;
    actual;
    name = 'AgentTerminalConfirmationError';
    constructor(reason, expected, actual) {
        super(terminalConfirmationMessage(reason, expected, actual));
        this.reason = reason;
        this.expected = expected;
        this.actual = actual;
    }
}
export class LocalRuntimeTerminalIdentityError extends Error {
    reason;
    name = 'LocalRuntimeTerminalIdentityError';
    constructor(reason) {
        super(`Local runtime terminal event is ${reason}.`);
        this.reason = reason;
    }
}
export class LocalRuntimeTerminalError extends Error {
    eventId;
    event;
    name = 'LocalRuntimeTerminalError';
    category = 'runtime';
    code;
    retryable;
    constructor(eventId, event, isRetryable) {
        super(terminalMessage(event) ?? 'Local runtime turn failed.');
        this.eventId = eventId;
        this.event = event;
        const errorCode = event.payload.error?.code;
        this.code = typeof errorCode === 'number' ? String(errorCode) : 'RUNTIME_ERROR';
        this.retryable = isRetryable(errorCode);
    }
}
/**
 * Owns ordered event/History processing and authoritative terminal staging for
 * one accepted Turn. LocalAgentHost remains the lifecycle owner and decides
 * when to drain, reconcile, run turn-end handlers, and commit the terminal.
 */
export class TurnCommitPipeline {
    dependencies;
    lane = new OrderedAgentEventLane();
    terminal;
    committedHistoryState;
    historyOperations = new Map();
    historyReplay;
    userMessageIdentities;
    fallbackHistoryOperationSequence = 0;
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.terminal = new TerminalEventBuffer(dependencies.isRuntimeErrorRetryable);
        this.committedHistoryState = new TurnCommittedHistoryState(dependencies.initialHistory);
        this.userMessageIdentities = new CanonicalUserMessageIdentityLane(dependencies.primaryUserMessageId, dependencies.primaryUserMessageBatch);
        this.historyReplay = new AgentHistoryOperationReplayCoordinator({
            context: dependencies.context,
            lane: this.lane,
            writer: dependencies.committedHistory,
            commit: (change) => this.commitAndHandleHistory(change),
        });
    }
    onRuntimeEvent = async (event) => {
        const outcome = terminalEventOutcome(event);
        if (!outcome && event.type === RuntimeEventType.TURN_TERMINAL) {
            await this.lane.enqueue(() => Promise.reject(new LocalRuntimeTerminalIdentityError('unsupported')));
            return;
        }
        if (outcome) {
            const claim = captureSync(() => this.terminal.claim(outcome));
            if (!claim.ok) {
                await this.lane.enqueue(() => Promise.reject(claim.error), true);
                return;
            }
            const snapshot = captureSync(() => captureSemanticSnapshot(event));
            if (!snapshot.ok) {
                await this.lane.enqueue(() => Promise.reject(snapshot.error), isNonNormalTerminalRuntimeEvent(event));
                return;
            }
            await this.lane.enqueue(() => {
                validateRuntimeAssociation(this.dependencies.context, snapshot.value.value);
                this.terminal.stage(snapshot.value.value);
                return Promise.resolve();
            }, isNonNormalTerminalRuntimeEvent(snapshot.value.value));
            return;
        }
        await this.lane.enqueue(async () => {
            validateRuntimeAssociation(this.dependencies.context, event);
            const signal = this.dependencies.lease.signal;
            try {
                const result = await this.dependencies.events.handleRuntimeEvent(this.dependencies.context, event, signal);
                new TerminalConfirmation().observe(event, result);
            }
            catch (error) {
                if (error instanceof Error &&
                    error.name === 'MessageWriteWaitAbortedError' &&
                    Reflect.get(error, 'signal') === signal &&
                    signal.aborted) {
                    // This lease cancelled a projection before its write began. Keep the
                    // lane available for the runner's abort reconciliation and terminal.
                    return;
                }
                throw error;
            }
        });
    };
    onHistoryChanged = (change) => this.enqueueHistory(change, false);
    registerCanonicalUserMessageIds = (messageIds, batchId) => {
        this.userMessageIdentities.register(messageIds, batchId);
    };
    rearmPrimaryUserMessageIdAfterOutputRecall = () => {
        this.userMessageIdentities.rearmPrimaryAfterOutputRecall();
    };
    drain() {
        return this.lane.settle();
    }
    requireTerminal(outcome) {
        return this.terminal.require(outcome);
    }
    resolveOutcome(reconcile) {
        return this.terminal.outcome(reconcile);
    }
    failedEvent(error) {
        return this.terminal.failedEvent(this.dependencies.context, error);
    }
    async reconcileHistory(intent) {
        await this.commitTurnMutation(reconcileMutation(this.dependencies.lease, intent), {
            retracted: intent.kind === 'output-recall',
        });
    }
    async recallOutputAttemptHistory(attempt) {
        await this.commitTurnMutation(retractMutation(this.dependencies.lease, {
            id: `agent-host:${this.dependencies.lease.turnId}:history:output-attempt-recall:${String(attempt)}`,
            kind: 'turn-retraction',
            variant: 'content',
        }, attempt), { retracted: true });
    }
    async commitOutcomeTerminal(control, event, outcome) {
        if (outcome.status === 'failed') {
            await this.commitFailedTerminal(control, event);
            return;
        }
        if (outcome.status === 'aborted') {
            await control.sealAbnormalTerminal();
        }
        await this.deliverTerminal(event, outcome);
    }
    async commitFailedTerminal(control, event) {
        await commitHostFailedTerminal({
            context: this.dependencies.context,
            control,
            event,
            events: this.dependencies.events,
        });
    }
    enqueueHistory(change, allowHostReservedOperation) {
        const prepared = captureSync(() => {
            const normalizedChange = normalizeHistoryMessagePayloads(change);
            const operation = normalizedChange.operation ??
                fallbackHistoryOperation(this.dependencies.lease.turnId, ++this.fallbackHistoryOperationSequence, normalizedChange);
            const identifiedChange = { ...normalizedChange, operation };
            validateHistoryAssociation(this.dependencies.context, identifiedChange);
            validateHistoryOperation(identifiedChange, this.dependencies.lease.turnId, allowHostReservedOperation);
            const snapshot = captureSemanticSnapshot(this.userMessageIdentities.decorate(identifiedChange, {
                messages: this.committedHistoryState.currentMessages,
                identityVector: this.committedHistoryState.currentIdentityVectorValue,
            }));
            return {
                change: snapshot.value,
                fingerprint: snapshot.fingerprint,
                operationId: snapshot.value.operation.id,
            };
        });
        if (!prepared.ok) {
            return this.historyReplay.rejectPreparation(change, prepared.error);
        }
        const replay = this.historyOperations.get(prepared.value.operationId);
        if (replay)
            return this.historyReplay.resolve(replay, prepared.value);
        const execution = this.historyReplay.enqueuePrepared(prepared.value, () => this.commitAndHandleHistory(prepared.value.change, (commit) => {
            this.committedHistoryState.record(commit);
        }));
        this.historyOperations.set(prepared.value.operationId, {
            fingerprint: prepared.value.fingerprint,
            execution,
        });
        return execution;
    }
    async commitAndHandleHistory(change, onCommitted) {
        const compactionAttemptId = readCompactionAttemptId(change.metadata);
        await this.dependencies.committedHistory.commit(this.dependencies.context, change, {
            ...(compactionAttemptId ? { compactionAttemptId } : {}),
            onDurableCommitted: (committed) => {
                onCommitted?.({
                    revision: committed.committedRevision,
                    messages: committed.committedMessages,
                    identityVector: committed.committedIdentityVector,
                });
            },
        });
    }
    async commitTurnMutation(mutation, options) {
        await this.dependencies.committedHistory.commitTurnMutation(this.dependencies.context, captureSemanticSnapshot(mutation).value, {
            onDurableCommitted: (committed) => {
                this.committedHistoryState.record({
                    revision: committed.committedRevision,
                    messages: committed.committedMessages,
                    identityVector: committed.committedIdentityVector,
                }, options.retracted);
            },
        });
    }
    async deliverTerminal(event, outcome) {
        const result = await this.dependencies.events.handleRuntimeEvent(this.dependencies.context, event);
        const confirmation = new TerminalConfirmation();
        confirmation.observe(event, result);
        confirmation.confirm(outcome);
    }
}
export async function commitHostFailedTerminal(input) {
    const sealResult = await capture(() => input.control.sealAbnormalTerminal());
    const deliveryResult = await capture(async () => {
        const result = await input.events.handleRuntimeEvent(input.context, input.event);
        const confirmation = new TerminalConfirmation();
        confirmation.observe(input.event, result);
        confirmation.confirm({ status: 'failed', error: undefined });
    });
    const failures = compactFailures([sealResult, deliveryResult]);
    if (failures.length > 0)
        throwFailures(failures, 'Agent terminal finalization failed.');
}
class OrderedAgentEventLane {
    queue = [];
    running;
    firstFailure;
    enqueue(operation, continueAfterFailure = false, onBlockedByFailure) {
        const execution = new Promise((resolve, reject) => {
            this.queue.push({
                operation,
                continueAfterFailure,
                ...(onBlockedByFailure ? { onBlockedByFailure } : {}),
                resolve,
                reject,
            });
        });
        this.start();
        return execution;
    }
    async settle() {
        await this.enqueue(() => Promise.resolve(), true);
        if (this.firstFailure)
            throw this.firstFailure.error;
    }
    start() {
        if (this.running)
            return;
        this.running = this.drain();
    }
    async drain() {
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next)
                await this.execute(next);
        }
        this.running = undefined;
    }
    async execute(item) {
        try {
            if (this.firstFailure && !item.continueAfterFailure) {
                await item.onBlockedByFailure?.(this.firstFailure.error);
                throw this.firstFailure.error;
            }
            await item.operation();
            item.resolve();
        }
        catch (error) {
            if (!this.firstFailure)
                this.firstFailure = { error };
            item.reject(error);
        }
    }
}
class TerminalEventBuffer {
    isRuntimeErrorRetryable;
    claimedOutcome;
    staged;
    constructor(isRuntimeErrorRetryable) {
        this.isRuntimeErrorRetryable = isRuntimeErrorRetryable;
    }
    claim(outcome) {
        if (this.claimedOutcome) {
            throw new AgentTerminalConfirmationError('conflict', this.claimedOutcome, outcome);
        }
        this.claimedOutcome = outcome;
    }
    stage(event) {
        const outcome = terminalEventOutcome(event);
        if (!outcome)
            return;
        if (this.staged) {
            throw new AgentTerminalConfirmationError('conflict', this.staged.outcome, outcome);
        }
        this.staged = { event, outcome };
    }
    require(outcome) {
        if (!this.staged) {
            throw new AgentTerminalConfirmationError('missing', outcome.status);
        }
        if (this.staged.outcome !== outcome.status) {
            throw new AgentTerminalConfirmationError('outcome-mismatch', outcome.status, this.staged.outcome);
        }
        return this.staged.event;
    }
    outcome(reconcile) {
        if (!this.staged)
            throw new LocalRuntimeTerminalIdentityError('missing');
        switch (this.staged.outcome) {
            case 'completed':
                return { status: 'completed', ...(reconcile ? { historyReconcile: reconcile } : {}) };
            case 'aborted': {
                const reason = terminalMessage(this.staged.event);
                return {
                    status: 'aborted',
                    ...(reason ? { reason } : {}),
                    ...(reconcile ? { historyReconcile: reconcile } : {}),
                };
            }
            case 'failed':
                return {
                    status: 'failed',
                    error: new LocalRuntimeTerminalError(this.staged.event.event_id, this.staged.event, this.isRuntimeErrorRetryable),
                };
        }
    }
    failedEvent(context, error) {
        return this.staged?.outcome === 'failed'
            ? this.staged.event
            : buildHostFailedEvent(context, error);
    }
}
class TerminalConfirmation {
    outcome;
    observe(event, result) {
        if (!result.terminal)
            return;
        const eventOutcome = terminalEventOutcome(event);
        if (!eventOutcome || eventOutcome !== result.outcome) {
            throw new AgentTerminalConfirmationError('event-mismatch', eventOutcome, result.outcome);
        }
        if (this.outcome && this.outcome !== result.outcome) {
            throw new AgentTerminalConfirmationError('conflict', this.outcome, result.outcome);
        }
        this.outcome = result.outcome;
    }
    confirm(outcome) {
        if (!this.outcome) {
            throw new AgentTerminalConfirmationError('missing', outcome.status);
        }
        if (this.outcome !== outcome.status) {
            throw new AgentTerminalConfirmationError('outcome-mismatch', outcome.status, this.outcome);
        }
    }
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
function normalizeHistoryMessagePayloads(change) {
    const messages = jsonRoundTrip(change.messages);
    if (change.previousMessages === undefined)
        return { ...change, messages };
    return {
        ...change,
        messages,
        previousMessages: jsonRoundTrip(change.previousMessages),
    };
}
function jsonRoundTrip(value) {
    try {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError('History messages must be JSON-serializable.');
        }
        return JSON.parse(serialized);
    }
    catch {
        throw new TypeError('History messages must be JSON-serializable.');
    }
}
function compactFailures(results) {
    return results.flatMap((result) => (result.ok ? [] : flattenFailure(result.error)));
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
function validateRuntimeAssociation(context, event) {
    assertAssociation('sessionId', context.sessionId, event.session_id);
    if (event.turn_id !== undefined) {
        assertAssociation('turnId', context.turnId, event.turn_id);
    }
}
function validateHistoryAssociation(context, change) {
    assertAssociation('sessionId', context.sessionId, change.sessionId);
    assertAssociation('turnId', context.turnId, change.turnId);
}
function assertAssociation(field, expected, actual) {
    if (expected !== actual) {
        throw new AgentEventAssociationError(field, expected, actual);
    }
}
function validateHistoryOperation(change, turnId, allowHostReservedOperation) {
    const operationId = change.operation.id;
    if (!operationId.trim()) {
        throw new AgentHistoryOperationIdentityError('missing-id', operationId);
    }
    if (!allowHostReservedOperation && operationId.startsWith(`agent-host:${turnId}:history:`)) {
        throw new AgentHistoryOperationIdentityError('reserved-id', operationId);
    }
    const expectedAppend = change.reason === 'messageDelta';
    const actualAppend = change.operation.kind === 'append';
    if (expectedAppend !== actualAppend) {
        throw new AgentHistoryOperationIdentityError('kind-mismatch', operationId);
    }
}
function fallbackHistoryOperation(turnId, sequence, change) {
    const compaction = readCompactionLifecycleMetadata(change.metadata);
    if (change.reason === 'replaceMessages' && compaction) {
        return {
            id: `${turnId}:history:compaction:${encodeURIComponent(compaction.compactionId)}`,
            kind: 'compaction',
        };
    }
    return {
        id: `${turnId}:history:${sequence}`,
        kind: change.reason === 'messageDelta' ? 'append' : 'replace',
    };
}
function reconcileMutation(lease, intent) {
    if (intent.kind === 'output-recall') {
        const reason = intent.source === 'input-review'
            ? { kind: 'input-safety-recall' }
            : { kind: 'output-final-recall' };
        return {
            kind: 'retract-turn',
            sessionId: lease.sessionId,
            turnId: lease.turnId,
            reason,
            operation: {
                id: `agent-host:${lease.turnId}:history:${reason.kind}`,
                kind: 'output-recall',
                variant: intent.variant,
                ...(intent.slowNetworkRead ? { slowNetworkRead: true } : {}),
            },
        };
    }
    const mode = intent.kind === 'abort-reconcile' ? 'abort' : 'network';
    return {
        kind: 'settle-turn-tail',
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        mode,
        approvedContent: intent.approvedContent,
        operation: {
            id: `agent-host:${lease.turnId}:history:${intent.kind}`,
            kind: intent.kind,
            ...(mode === 'network' ? { variant: 'network' } : {}),
            ...(intent.kind === 'network-reconcile' && intent.slowNetworkRead
                ? { slowNetworkRead: true }
                : {}),
        },
    };
}
function retractMutation(lease, operation, attempt) {
    return {
        kind: 'retract-turn',
        sessionId: lease.sessionId,
        turnId: lease.turnId,
        reason: { kind: 'output-attempt-recall', attempt },
        operation,
    };
}
function isNonNormalTerminalRuntimeEvent(event) {
    const outcome = terminalEventOutcome(event);
    return outcome === 'failed' || outcome === 'aborted';
}
function terminalEventOutcome(event) {
    if (event.type !== RuntimeEventType.SESSION_STATUS &&
        event.type !== RuntimeEventType.TURN_TERMINAL) {
        return undefined;
    }
    switch (event.payload.status) {
        case RuntimeEventStatus.COMPLETED:
            return 'completed';
        case RuntimeEventStatus.FAILED:
            return 'failed';
        case RuntimeEventStatus.ABORTED:
            return 'aborted';
        default:
            return undefined;
    }
}
function terminalMessage(event) {
    const stopReason = event.payload.stop_reason;
    if (stopReason?.message?.trim())
        return stopReason.message.trim();
    const error = event.payload.error;
    return error?.message?.trim() ? error.message.trim() : undefined;
}
function terminalConfirmationMessage(reason, expected, actual) {
    if (reason === 'missing') {
        return `Agent runner settled as ${expected ?? 'unknown'} without a handled terminal event.`;
    }
    return `Agent terminal confirmation ${reason}: expected ${expected ?? 'none'}, received ${actual ?? 'none'}.`;
}
//# sourceMappingURL=turn-commit-pipeline.js.map