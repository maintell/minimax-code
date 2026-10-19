import { sessionAgentState } from '../../../../infra/db/schema/sessions.js';
export function decideAgentState(current, input) {
    if (!current)
        return 'apply';
    if (input.turnSequence < current.turnSequence)
        return 'stale';
    if (input.turnSequence > current.turnSequence)
        return 'apply';
    if (input.turnId !== current.turnId)
        return 'conflict';
    if (current.terminalOutcome)
        return decideTerminalState(current, input);
    if (input.eventId === current.eventId)
        return 'duplicate';
    if (input.runtimeSeq !== undefined &&
        current.runtimeSeq !== null &&
        input.runtimeSeq <= current.runtimeSeq) {
        return 'duplicate';
    }
    return 'apply';
}
export function agentStateRow(current, input, nowMs) {
    return {
        sessionId: input.sessionId,
        turnId: input.turnId,
        turnSequence: input.turnSequence,
        runtimeSeq: resolvedRuntimeSeq(current, input),
        eventId: input.eventId,
        terminalOutcome: input.terminalOutcome ?? null,
        updatedAtMs: nowMs,
    };
}
function decideTerminalState(current, input) {
    if (!input.terminalOutcome)
        return 'stale';
    if (input.runtimeSeq !== undefined &&
        current.runtimeSeq !== null &&
        input.runtimeSeq < current.runtimeSeq) {
        return 'stale';
    }
    return input.eventId === current.eventId &&
        resolvedRuntimeSeq(current, input) === current.runtimeSeq &&
        input.terminalOutcome === current.terminalOutcome
        ? 'duplicate'
        : 'conflict';
}
export function assertAgentStateMutation(input) {
    if (!input.sessionId ||
        !input.turnId ||
        !input.eventId ||
        !Number.isSafeInteger(input.turnSequence) ||
        input.turnSequence <= 0 ||
        (input.runtimeSeq !== undefined &&
            (!Number.isSafeInteger(input.runtimeSeq) || input.runtimeSeq <= 0))) {
        throw new TypeError('Agent Session state mutation has an invalid identity.');
    }
}
function resolvedRuntimeSeq(current, input) {
    if (input.runtimeSeq !== undefined)
        return input.runtimeSeq;
    if (current?.turnSequence !== input.turnSequence || current.turnId !== input.turnId)
        return null;
    return current.runtimeSeq;
}
//# sourceMappingURL=agent-state.js.map