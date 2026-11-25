import { RuntimeEventType } from '@mavis/agent-core/protocol';
/**
 * @internal Exported only for focused tests.
 *
 * A write of a Turn whose ownership was taken away by force (context reset
 * spec 3.2): the Session belongs to newer work, so the write is refused.
 */
export class ForceReleasedTurnWriteError extends Error {
    name = 'ForceReleasedTurnWriteError';
    constructor(sessionId, turnId) {
        super(`Turn ${sessionId}/${turnId} was ended by force; its late write is dropped.`);
    }
}
/**
 * A Turn ended by force keeps running until it notices; whatever it writes
 * afterwards (model output, tool results, its terminal, the failure of a
 * refused commit) reaches neither the canonical history, the conversation the
 * user sees nor the Session's state, which belongs to the reset and the Turns
 * after it; a refused commit is only logged. Turns the controller never ended
 * by force write as before.
 */
export function fenceForceReleasedTurns(dependencies) {
    const control = dependencies.turnControl;
    const isForceReleased = control.isForceReleased?.bind(control);
    if (!isForceReleased)
        return dependencies;
    const guard = (sessionId, turnId) => {
        if (isForceReleased(sessionId, turnId))
            throw new ForceReleasedTurnWriteError(sessionId, turnId);
    };
    const historyFailure = dependencies.historyFailure;
    return {
        ...dependencies,
        history: fenceHistory(dependencies.history, guard),
        events: fenceEvents(dependencies.events, isForceReleased),
        ...(historyFailure
            ? {
                historyFailure: fenceHistoryFailure(historyFailure, isForceReleased, dependencies.logger),
            }
            : {}),
    };
}
function fenceHistoryFailure(historyFailure, isForceReleased, logger) {
    return {
        fail: async (input) => {
            if (!isForceReleased(input.sessionId, input.turnId)) {
                await historyFailure.fail(input);
                return;
            }
            try {
                logger?.info?.({
                    event: 'force_released_turn_commit_dropped',
                    session_id: input.sessionId,
                    turn_id: input.turnId,
                }, '[local-runtime-v2] Late commit of a Turn ended by force was dropped');
            }
            catch {
                // Diagnostics never reach the Session.
            }
        },
    };
}
function fenceHistory(history, guard) {
    const compact = history.compact?.bind(history);
    const settleTurnTail = history.settleTurnTail?.bind(history);
    const retractTurn = history.retractTurn?.bind(history);
    return {
        read: (sessionId) => history.read(sessionId),
        append: async (change) => {
            guard(change.sessionId, change.turnId);
            return history.append(change);
        },
        replace: async (change) => {
            guard(change.sessionId, change.turnId);
            return history.replace(change);
        },
        ...(compact
            ? {
                compact: async (change) => {
                    guard(change.sessionId, change.turnId);
                    return compact(change);
                },
            }
            : {}),
        ...(settleTurnTail
            ? {
                settleTurnTail: async (mutation) => {
                    guard(mutation.sessionId, mutation.turnId);
                    return settleTurnTail(mutation);
                },
            }
            : {}),
        ...(retractTurn
            ? {
                retractTurn: async (mutation) => {
                    guard(mutation.sessionId, mutation.turnId);
                    return retractTurn(mutation);
                },
            }
            : {}),
    };
}
function fenceEvents(events, isForceReleased) {
    return {
        // Asked as the Turn starts, before anything can release it; observers read its content only
        // through the frames below, which the fence still drops for a released Turn.
        observesTurnContent: async (sessionId) => (await events.observesTurnContent?.(sessionId)) ?? false,
        handleRuntimeEvent: async (context, event, signal, content) => {
            if (!isForceReleased(context.sessionId, context.turnId)) {
                return events.handleRuntimeEvent(context, event, signal, content);
            }
            // The Turn already ended as stopped; its own terminal changes nothing.
            return event.type === RuntimeEventType.TURN_TERMINAL
                ? { terminal: true, outcome: 'aborted' }
                : { terminal: false };
        },
        handleHistoryCommitted: async (context, change) => {
            if (isForceReleased(context.sessionId, context.turnId))
                return;
            await events.handleHistoryCommitted(context, change);
        },
    };
}
//# sourceMappingURL=released-turn-fence.js.map