import { isTurnTerminatingToolResultDetails } from '@mavis/agent-core/tools';
import { validateCanonicalHistoryMessages, validateCanonicalHistorySnapshot, } from './canonical-history-validation.js';
import { isBackgroundTaskReadSettlement } from './background/task-read-settlement.js';
class TurnContinuationUnavailableError extends Error {
    state;
    name = 'TurnContinuationUnavailableError';
    constructor(state) {
        super(`Turn continuation is unavailable: ${state}.`);
        this.state = state;
    }
}
/**
 * Derives product continuation state from canonical Pi history only.
 *
 * A tool-result tail is normally the middle of an interrupted Turn, so it
 * stays continuable. Two kinds of tail are not: a tool that handed control
 * back to the user, and a tool that deliberately ended its Turn. Neither has
 * interrupted work behind it, and `terminate` itself is not persisted, so both
 * are read from the durable markers the producing tools publish in `details`.
 */
export function inspectContinuationHistory(messages) {
    validateCanonicalHistoryMessages(messages);
    const last = continuationTail(messages)?.message;
    if (!last || last.role === 'compactionSummary')
        return 'unavailable';
    if (last.role === 'toolResult') {
        if (isWaitingForUser(last))
            return 'waiting-for-user';
        if (isTurnTerminatingToolResultDetails(last.details))
            return 'unavailable';
    }
    if (last.role !== 'assistant')
        return 'available';
    return last.stopReason === 'stop' ? 'unavailable' : 'available';
}
/**
 * Builds the transcript accepted by Pi `continue()`. A non-terminal assistant
 * tail is the interrupted LLM attempt itself, so it is retried in memory while
 * the durable canonical record remains available for audit and projection.
 */
export function continuationRunnerHistory(snapshot) {
    validateCanonicalHistorySnapshot(snapshot);
    const state = inspectContinuationHistory(snapshot.messages);
    if (state !== 'available')
        throw new TurnContinuationUnavailableError(state);
    const tail = continuationTail(snapshot.messages);
    if (tail?.message.role !== 'assistant')
        return snapshot;
    return {
        ...snapshot,
        messages: snapshot.messages.filter((_, index) => index !== tail.index),
        ...(snapshot.identityVector
            ? { identityVector: snapshot.identityVector.filter((_, index) => index !== tail.index) }
            : {}),
    };
}
function continuationTail(messages) {
    let index = messages.length - 1;
    while (index >= 0) {
        const message = messages[index];
        if (message && !isBackgroundTaskReadSettlement(message))
            return { index, message };
        index -= 1;
    }
    return undefined;
}
function isWaitingForUser(message) {
    return (message.toolName === 'ask_user' ||
        (isRecord(message.details) && message.details.waiting_for_user === true));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=continuation-history.js.map