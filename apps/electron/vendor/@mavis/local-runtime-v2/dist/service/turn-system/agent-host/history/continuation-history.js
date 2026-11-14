import { isTurnStoppingToolResultDetails, isTurnTerminatingToolResultDetails, } from '@mavis/agent-core/tools';
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
export function inspectContinuationHistory(messages, context = {}) {
    validateCanonicalHistoryMessages(messages);
    const last = decidingTail(messages);
    if (!last || last.role === 'compactionSummary')
        return 'unavailable';
    if (last.role === 'toolResult') {
        if (!failedTurnOwnsTail(context) && isWaitingForUser(last))
            return 'waiting-for-user';
        if (isTurnTerminatingToolResultDetails(last.details))
            return 'unavailable';
    }
    if (last.role !== 'assistant')
        return 'available';
    return last.stopReason === 'stop' ? 'unavailable' : 'available';
}
/**
 * Rule 1 applies only when the tail was written by the Turn that failed.
 *
 * A later Turn can fail before it writes anything (its input never reaches
 * history when preflight fails), which leaves an older Turn's blocking tail in
 * place. Continuing from there would step over that block and silently drop
 * the newer user message, so the tail must belong to the failed Turn.
 *
 * Preflight re-uses the admission decision through the request and carries no
 * ids to compare; an absent `failedTurnId` therefore means "already decided".
 */
function failedTurnOwnsTail(context) {
    if (context.previousTurnFailed !== true)
        return false;
    if (context.failedTurnId === undefined)
        return true;
    return context.tailTurnId === context.failedTurnId;
}
/**
 * Builds the transcript accepted by Pi `continue()`. A non-terminal assistant
 * tail is the interrupted LLM attempt itself, so it is retried in memory while
 * the durable canonical record remains available for audit and projection.
 */
export function continuationRunnerHistory(snapshot, context = {}) {
    validateCanonicalHistorySnapshot(snapshot);
    const state = inspectContinuationHistory(snapshot.messages, context);
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
/** Diagnostic view of the tail's user-wait marker, for continuation logging. */
export function continuationTailWait(messages) {
    validateCanonicalHistoryMessages(messages);
    const last = decidingTail(messages);
    if (last?.role !== 'toolResult')
        return undefined;
    return {
        toolName: last.toolName,
        waitingForUser: isRecord(last.details) ? last.details.waiting_for_user : undefined,
        waiting: isWaitingForUser(last),
    };
}
/**
 * Durable `turn_id` of the continuation tail. Uses the same tail selection as
 * the state derivation, so a trailing Background read settlement is skipped
 * here exactly as it is there.
 */
export function continuationTailTurnId(messages, turnIdVector) {
    if (!turnIdVector)
        return undefined;
    validateCanonicalHistoryMessages(messages);
    const tail = continuationTail(messages);
    return tail ? turnIdVector[tail.index] : undefined;
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
/**
 * The message whose markers decide the continuation tail. A result that
 * stopped the run (pi `terminateAgent`) ended its batch even when pi wrote
 * skipped results for the calls after it, so it decides rather than the last
 * sibling; a result in that batch that waits for the user decides before it.
 * Any other tail decides by itself. The state and its diagnostic view share it.
 */
function decidingTail(messages) {
    const tail = continuationTail(messages);
    if (!tail)
        return undefined;
    const batch = [];
    for (let at = tail.index; at >= 0; at -= 1) {
        const message = messages[at];
        if (message?.role !== 'toolResult')
            break;
        batch.push(message);
    }
    const stop = batch.find((message) => message.role === 'toolResult' && isTurnStoppingToolResultDetails(message.details));
    if (!stop)
        return tail.message;
    return (batch.find((message) => message.role === 'toolResult' &&
        isRecord(message.details) &&
        message.details.waiting_for_user === true) ?? stop);
}
function isWaitingForUser(message) {
    // The producing tool owns this answer. ask_user v2 resolves inline and keeps
    // the Turn running, so it reports an explicit `false`; only results written
    // before that protocol existed fall back to the tool name.
    const declared = isRecord(message.details) ? message.details.waiting_for_user : undefined;
    if (typeof declared === 'boolean')
        return declared;
    return message.toolName === 'ask_user';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=continuation-history.js.map