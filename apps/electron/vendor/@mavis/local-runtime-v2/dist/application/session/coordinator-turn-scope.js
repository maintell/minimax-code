import { scopeAgentExtension, } from '../../service/turn-system/index.js';
/**
 * A coordinator's Turn extension, mounted only on a coordinator Agent's own
 * Sessions, judged from the assembly context without a read.
 */
export function scopeToCoordinatorSessions(extension, ownership) {
    return scopeAgentExtension(extension, (turn) => ownership.standing(turn) === 'coordinator');
}
/**
 * A coordinator's per-Turn extensions, judged without a read: the execution
 * reminder on every Session a coordinator assigned a task to, a coordinator
 * Agent's own Session included; the round budget on a coordinator Agent's own
 * Sessions.
 */
export function scopeCoordinatorTurnExtensions(ownership, extensions) {
    return [
        scopeAgentExtension(extensions.executionReminder, (turn) => ownership.isAssignedTask(turn.sessionId)),
        scopeToCoordinatorSessions(extensions.roundBudget, ownership),
    ];
}
/** Sessions whose Agent is remembered; each Session's Agent is fixed when it is created. */
const MAX_REMEMBERED_SESSIONS = 4096;
/**
 * A coordinator's Turn observers, reached only for a coordinator Agent's own
 * Sessions. The Session's Agent comes from the event (the Turn context once its
 * preflight has run, or the terminal), from an earlier call of the same Session,
 * or else from one read of the Session in the shared database; it is judged
 * against the roster as it is at each call. A Session whose Agent cannot be
 * read still reaches the observers, as without the scope. `mayCoordinate`
 * answers the same for the coordinator's other per-Session work; a caller that
 * knows the Session's Agent passes it.
 */
export function scopeCoordinatorTurnObservers(ownership, observers) {
    const reaches = coordinatorSessionJudge(ownership);
    const fromContext = (input) => reaches(input.context.sessionId, input.context.resourceAgentName);
    const fromTerminal = (turn) => reaches(turn.context.sessionId, turn.agentName);
    const { silence, state } = observers;
    return {
        silence: {
            recordConsumedSteering: (input) => {
                if (reaches(input.sessionId))
                    silence.recordConsumedSteering(input);
            },
            observeRuntimeEvent: (input) => fromContext(input) ? silence.observeRuntimeEvent?.(input) : undefined,
            observeHistoryCommitted: (input) => fromContext(input) ? silence.observeHistoryCommitted?.(input) : undefined,
            observeHistoryFailure: (input) => reaches(input.sessionId) ? silence.observeHistoryFailure?.(input) : undefined,
            payload: (turn) => (fromTerminal(turn) ? silence.payload(turn) : undefined),
            published: (turn) => {
                if (fromTerminal(turn))
                    silence.published(turn);
            },
        },
        state: {
            observeRuntimeEvent: (input) => fromContext(input) ? state.observeRuntimeEvent?.(input) : undefined,
            observeHistoryCommitted: (input) => fromContext(input) ? state.observeHistoryCommitted?.(input) : undefined,
            observeHistoryFailure: (input) => reaches(input.sessionId) ? state.observeHistoryFailure?.(input) : undefined,
        },
        mayCoordinate: reaches,
    };
}
/**
 * A coordinator's Turn timing, reached only for the Sessions that may be a
 * coordinator Agent's own, judged as `mayCoordinate` judges them.
 */
export function scopeCoordinatorTurnTiming(timing, mayCoordinate) {
    return {
        hostStarted: (turn) => {
            if (mayCoordinate(turn.sessionId))
                timing.hostStarted(turn);
        },
        mainRequestPrepared: (turn) => {
            if (mayCoordinate(turn.sessionId))
                timing.mainRequestPrepared(turn);
        },
        steeringPreemption: (turn, result) => {
            if (mayCoordinate(turn.sessionId))
                timing.steeringPreemption?.(turn, result);
        },
        steeringAdmitted: (input) => {
            if (mayCoordinate(input.sessionId))
                timing.steeringAdmitted?.(input);
        },
        steeringConsumed: (input) => {
            if (mayCoordinate(input.sessionId))
                timing.steeringConsumed?.(input);
        },
        steeringDiscarded: (input) => {
            if (mayCoordinate(input.sessionId))
                timing.steeringDiscarded?.(input);
        },
        observeRuntimeEvent: (input) => mayCoordinate(input.context.sessionId, input.context.resourceAgentName)
            ? timing.observeRuntimeEvent?.(input)
            : undefined,
    };
}
/** Global events whose `agentName` is their Session's own Agent. */
const SESSION_AGENT_EVENTS = new Set(['session.created', 'session.start']);
/**
 * A coordinator's global-event subscription, reached only by events of the
 * Sessions that may be a coordinator Agent's own, judged as `mayCoordinate`
 * judges them. A Session's creation and its Turn starts name its Agent; an
 * event of no Session reaches the listener.
 */
export function scopeEventsToCoordinatorSessions(events, mayCoordinate) {
    return {
        subscribe: (listener) => events.subscribe({
            next: (event) => {
                if (eventMayCoordinate(event, mayCoordinate))
                    listener(event);
            },
        }),
    };
}
function eventMayCoordinate(event, mayCoordinate) {
    const payload = event.payload;
    if (typeof payload.sessionId !== 'string')
        return true;
    const agentName = SESSION_AGENT_EVENTS.has(event.type) && typeof payload.agentName === 'string'
        ? payload.agentName
        : undefined;
    return mayCoordinate(payload.sessionId, agentName);
}
/**
 * Remembers each Session's Agent, never the verdict: a roster read again later
 * judges the same Session anew.
 */
function coordinatorSessionJudge(ownership) {
    const agents = new Map();
    const remember = (sessionId, agentName) => {
        if (agents.has(sessionId))
            return;
        agents.set(sessionId, agentName);
        const oldest = agents.keys().next();
        if (agents.size > MAX_REMEMBERED_SESSIONS && !oldest.done)
            agents.delete(oldest.value);
    };
    /** The Session's Agent; null for a missing Session, undefined when it cannot be read. */
    const agentOf = (sessionId) => {
        const known = agents.get(sessionId);
        if (known !== undefined || !ownership.agentOf)
            return known;
        try {
            return ownership.agentOf(sessionId);
        }
        catch {
            return undefined;
        }
    };
    return (sessionId, agentName) => {
        const agent = agentName ?? agentOf(sessionId);
        if (agent === undefined)
            return true;
        if (agent === null)
            return false;
        remember(sessionId, agent);
        return ownership.standing({ sessionId, agentName: agent }) === 'coordinator';
    };
}
//# sourceMappingURL=coordinator-turn-scope.js.map