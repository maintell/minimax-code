import { RUNTIME_EVENT_SCHEMA, RuntimeEventStatus, RuntimeEventType, } from '@mavis/agent-core/protocol';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import { AgentHostDependencyUnavailableError, assertAgentHostCapabilityAvailable, } from '../empty-dependencies.js';
import { AgentEventAssociationError } from '../local-agent-host.js';
import { captureSemanticSnapshot } from '../history/semantic-identity.js';
import { SemanticReplayRegistry } from './semantic-replay-registry.js';
const DEFAULT_MAX_TRACKED_IDENTITIES = 4_096;
export class AgentEventIdentityConflictError extends Error {
    kind;
    identity;
    name = 'AgentEventIdentityConflictError';
    constructor(kind, identity) {
        super(`Agent ${kind} identity collision: ${identity}.`);
        this.kind = kind;
        this.identity = identity;
    }
}
export class AgentEventSequenceError extends Error {
    kind;
    expectedGreaterThan;
    actual;
    name = 'AgentEventSequenceError';
    constructor(kind, expectedGreaterThan, actual) {
        super(`Agent ${kind} must be greater than ${expectedGreaterThan}; received ${actual}.`);
        this.kind = kind;
        this.expectedGreaterThan = expectedGreaterThan;
        this.actual = actual;
    }
}
export class AgentEventValidationError extends Error {
    field;
    name = 'AgentEventValidationError';
    constructor(field) {
        super(`Agent event ${field} is invalid.`);
        this.field = field;
    }
}
export class AgentEventAcknowledgementError extends Error {
    expected;
    actual;
    name = 'AgentEventAcknowledgementError';
    constructor(expected, actual) {
        super(`Agent event acknowledgement mismatch: expected ${expected}, received ${actual}.`);
        this.expected = expected;
        this.actual = actual;
    }
}
export class AgentHistoryFailureValidationError extends Error {
    field;
    name = 'AgentHistoryFailureValidationError';
    constructor(field) {
        super(`Agent history failure ${field} is invalid.`);
        this.field = field;
    }
}
/**
 * Turn-owned durable event pipeline. Every required projector is awaited in a
 * per-Session lane; UI/observability callbacks are explicitly best-effort.
 */
export class RequiredAgentEventDelivery {
    options;
    lane = new KeyedOperationLane();
    runtimeReplays;
    historyReplays;
    sessionFences = new Map();
    runtimeSequences = new Map();
    observations = new WeakSet();
    constructor(options) {
        this.options = options;
        validateProjectors(options.projectors);
        const maximum = options.maxTrackedIdentities ?? DEFAULT_MAX_TRACKED_IDENTITIES;
        if (!Number.isSafeInteger(maximum) || maximum <= 0) {
            throw new AgentEventValidationError('maxTrackedIdentities');
        }
        this.runtimeReplays = new SemanticReplayRegistry(maximum);
        this.historyReplays = new SemanticReplayRegistry(maximum);
    }
    handleRuntimeEvent(context, event, signal) {
        try {
            const snapshot = captureSemanticSnapshot({ context, event });
            validateRuntimeInput(snapshot.value.context, snapshot.value.event);
            const identity = runtimeIdentity(snapshot.value.context, snapshot.value.event.event_id);
            return this.runtimeReplays.run({
                identity,
                fingerprint: snapshot.fingerprint,
                conflict: () => new AgentEventIdentityConflictError('runtime-event', identity),
                execute: () => this.lane.run(snapshot.value.context.sessionId, () => this.projectRuntime(snapshot.value.context, snapshot.value.event, signal)),
            });
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    handleHistoryCommitted(context, change) {
        try {
            const snapshot = captureSemanticSnapshot({ context, change });
            validateHistoryInput(snapshot.value.context, snapshot.value.change);
            const identity = historyIdentity(snapshot.value.context, snapshot.value.change);
            return this.historyReplays.run({
                identity,
                fingerprint: snapshot.fingerprint,
                conflict: () => new AgentEventIdentityConflictError('history-committed', identity),
                execute: () => this.lane.run(snapshot.value.context.sessionId, () => this.projectHistory(snapshot.value.context, snapshot.value.change)),
            });
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    fail(input) {
        try {
            const snapshot = captureSemanticSnapshot(input).value;
            validateHistoryFailure(snapshot);
            const projector = this.options.historyFailures;
            if (typeof projector?.projectHistoryFailure !== 'function') {
                throw new AgentHostDependencyUnavailableError('history-failure-projector');
            }
            return this.lane.run(snapshot.sessionId, async () => {
                await projector.projectHistoryFailure(snapshot);
                this.observe('history-failure', snapshot, () => this.options.observer?.observeHistoryFailure?.(snapshot));
            });
        }
        catch (error) {
            return Promise.reject(error);
        }
    }
    async projectRuntime(context, event, signal) {
        const runtimeSequence = this.validateSequence(context, event);
        const authoritative = await this.options.projectors.session.projectRuntimeEvent({
            context,
            event,
        });
        if (!authoritative) {
            throw new AgentEventAcknowledgementError(terminalOutcome(event) ?? 'non-terminal', 'missing');
        }
        validateAcknowledgement(event, authoritative);
        await this.options.projectors.messages.projectRuntimeEvent({
            context,
            event,
            ...(signal ? { signal } : {}),
        });
        await this.options.projectors.stream.projectRuntimeEvent({ context, event });
        await this.options.projectors.turnFacts.projectRuntimeEvent({ context, event });
        this.commitSequence(context, runtimeSequence);
        this.observe('runtime-event', context, () => this.options.observer?.observeRuntimeEvent?.({ context, event }));
        return authoritative;
    }
    async projectHistory(context, change) {
        this.validateTurnFence(context);
        await this.options.projectors.messages.projectHistoryCommitted({ context, change });
        await this.options.projectors.turnFacts.projectHistoryCommitted({ context, change });
        this.commitTurnFence(context);
        this.observe('history-committed', context, () => this.options.observer?.observeHistoryCommitted?.({ context, change }));
    }
    validateSequence(context, event) {
        this.validateTurnFence(context);
        const runtimeSequence = parseRuntimeSequence(event.runtime_seq);
        if (runtimeSequence === undefined)
            return undefined;
        const key = turnIdentity(context);
        const previous = this.runtimeSequences.get(key);
        if (previous !== undefined && runtimeSequence <= previous) {
            throw new AgentEventSequenceError('runtime-sequence', previous, runtimeSequence);
        }
        return runtimeSequence;
    }
    validateTurnFence(context) {
        const previous = this.sessionFences.get(context.sessionId);
        if (previous && context.turnSequence < previous.turnSequence) {
            throw new AgentEventSequenceError('turn-sequence', previous.turnSequence, context.turnSequence);
        }
        if (previous &&
            context.turnSequence === previous.turnSequence &&
            context.turnId !== previous.turnId) {
            throw new AgentEventSequenceError('turn-sequence', previous.turnSequence, context.turnSequence);
        }
    }
    commitSequence(context, runtimeSequence) {
        this.commitTurnFence(context);
        if (runtimeSequence !== undefined) {
            this.runtimeSequences.set(turnIdentity(context), runtimeSequence);
        }
    }
    commitTurnFence(context) {
        const previous = this.sessionFences.get(context.sessionId);
        if (!previous || context.turnSequence > previous.turnSequence) {
            this.sessionFences.set(context.sessionId, {
                turnSequence: context.turnSequence,
                turnId: context.turnId,
            });
        }
    }
    observe(stage, identity, operation) {
        // Intentionally detached: graceful shutdown does not drain product
        // observers such as an in-flight Channel final reply. We accept the rare
        // lost external reply instead of coupling durable Turn settlement to an
        // outbox or a second shutdown-drain protocol.
        const observation = this.runObservation(stage, identity, operation);
        this.observations.add(observation);
    }
    async runObservation(stage, identity, operation) {
        try {
            await operation();
        }
        catch (error) {
            try {
                this.options.onObservationFailure?.({
                    stage,
                    sessionId: identity.sessionId,
                    turnId: identity.turnId,
                    error,
                });
            }
            catch {
                // A best-effort diagnostics reporter cannot escape into the required path.
            }
        }
    }
}
function validateProjectors(projectors) {
    const runtimeEntries = [
        ['session-event-projector', projectors?.session],
        ['message-event-projector', projectors?.messages],
        ['stream-event-projector', projectors?.stream],
        ['turn-fact-event-projector', projectors?.turnFacts],
    ];
    runtimeEntries.forEach(([capability, projector]) => {
        assertAgentHostCapabilityAvailable(capability, typeof projector?.projectRuntimeEvent === 'function');
    });
    assertAgentHostCapabilityAvailable('message-history-projector', typeof projectors?.messages?.projectHistoryCommitted === 'function');
    assertAgentHostCapabilityAvailable('turn-fact-event-projector', typeof projectors?.turnFacts?.projectHistoryCommitted === 'function');
}
function validateRuntimeInput(context, event) {
    validateContext(context);
    if (event.schema !== RUNTIME_EVENT_SCHEMA)
        throw new AgentEventValidationError('schema');
    requireNonEmpty(event.event_id, 'event_id');
    assertAssociation('sessionId', context.sessionId, event.session_id);
    if (event.turn_id !== undefined) {
        assertAssociation('turnId', context.turnId, event.turn_id);
    }
    parseRuntimeSequence(event.runtime_seq);
}
function validateHistoryInput(context, change) {
    validateContext(context);
    assertAssociation('sessionId', context.sessionId, change.sessionId);
    assertAssociation('turnId', context.turnId, change.turnId);
    requireNonEmpty(change.committedRevision, 'committedRevision');
    requireNonEmpty(change.operation.id, 'operation.id');
    if (!Array.isArray(change.messages) || !Array.isArray(change.committedMessages)) {
        throw new AgentEventValidationError('history.messages');
    }
}
function validateContext(context) {
    requireNonEmpty(context.sessionId, 'context.sessionId');
    requireNonEmpty(context.turnId, 'context.turnId');
    if (!Number.isSafeInteger(context.turnSequence) || context.turnSequence <= 0) {
        throw new AgentEventValidationError('context.turnSequence');
    }
}
function validateHistoryFailure(input) {
    if (!input.sessionId.trim())
        throw new AgentHistoryFailureValidationError('sessionId');
    if (!input.turnId.trim())
        throw new AgentHistoryFailureValidationError('turnId');
}
function validateAcknowledgement(event, result) {
    const expected = terminalOutcome(event);
    const actual = acknowledgementOutcome(result);
    if (expected === undefined && result.terminal === false)
        return;
    if (expected !== undefined && result.terminal === true && expected === result.outcome)
        return;
    throw new AgentEventAcknowledgementError(expected ?? 'non-terminal', actual);
}
function acknowledgementOutcome(result) {
    if (result.terminal === true)
        return result.outcome;
    if (result.terminal === false)
        return 'non-terminal';
    return 'invalid';
}
function terminalOutcome(event) {
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
function runtimeIdentity(context, eventId) {
    return `${turnIdentity(context)}\u0000runtime:${eventId}`;
}
function historyIdentity(context, change) {
    return `${turnIdentity(context)}\u0000history:${requireNonEmpty(change.operation.id, 'operation.id')}`;
}
function turnIdentity(context) {
    return `${context.sessionId}\u0000${context.turnSequence}\u0000${context.turnId}`;
}
function assertAssociation(field, expected, actual) {
    if (expected !== actual)
        throw new AgentEventAssociationError(field, expected, actual);
}
function requireNonEmpty(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new AgentEventValidationError(field);
    return value;
}
function parseRuntimeSequence(value) {
    if (value === undefined)
        return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new AgentEventValidationError('runtime_seq');
    }
    return parsed;
}
//# sourceMappingURL=required-agent-event-delivery.js.map