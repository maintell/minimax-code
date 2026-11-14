import { continuationTailTurnId, continuationTailWait, inspectContinuationHistory, } from '../agent-host/history/continuation-history.js';
export function createTurnContinuationService(options) {
    const decide = async (sessionId) => {
        if (options.execution.activeTurnId(sessionId)) {
            return { state: 'running', previousTurnFailed: false };
        }
        const history = await options.history.inspectActive(sessionId);
        const terminal = await options.previousTurn.readTerminal(sessionId);
        const previousTurnFailed = terminal?.outcome === 'failed';
        const tailTurnId = continuationTailTurnId(history.messages, history.turnIdVector);
        const state = inspectContinuationHistory(history.messages, {
            previousTurnFailed,
            ...(terminal ? { failedTurnId: terminal.turnId } : {}),
            ...(tailTurnId ? { tailTurnId } : {}),
        });
        logWaitDecision(options.logger, {
            sessionId,
            messages: history.messages,
            terminal,
            previousTurnFailed,
            tailTurnId,
            state,
        });
        // Keep the source of the input being resumed, never the last IM chat used
        // by this Session. Repeated retries may have no new user message.
        let continuedFromTurnId;
        for (let index = history.messages.length - 1; index >= 0; index -= 1) {
            const message = history.messages[index];
            if (typeof message === 'object' &&
                message !== null &&
                'role' in message &&
                message.role === 'user') {
                continuedFromTurnId = history.turnIdVector?.[index];
                break;
            }
        }
        return { state, previousTurnFailed, ...(continuedFromTurnId ? { continuedFromTurnId } : {}) };
    };
    return {
        inspect: async (sessionId) => ({ state: (await decide(sessionId)).state }),
        continueTurn: async (input) => {
            if (input.signal?.aborted)
                return { accepted: false, reason: 'unavailable' };
            const decision = await decide(input.sessionId);
            if (input.signal?.aborted)
                return { accepted: false, reason: 'unavailable' };
            if (decision.state === 'running')
                return { accepted: false, reason: 'active-turn' };
            if (decision.state !== 'available') {
                return { accepted: false, reason: decision.state };
            }
            return options.execution.submit({
                sessionId: input.sessionId,
                input: { text: '' },
                genuineUserQueryText: '',
                provenance: {
                    source: 'turn-continuation',
                    routingFingerprint: `turn-continuation:${input.sessionId}`,
                    ...(decision.continuedFromTurnId
                        ? { sourceContext: { continuedFromTurnId: decision.continuedFromTurnId } }
                        : {}),
                },
                clientIntent: 'turn-continuation',
                admissionPriority: { kind: 'turn-continuation' },
                executionMode: 'continuation',
                // Preflight re-derives the same state after admission cleared the
                // durable failure fact, so the decision travels with the request.
                ...(decision.previousTurnFailed ? { continuationAfterFailedTurn: true } : {}),
                ...(input.signal ? { signal: input.signal } : {}),
                ...(input.onAccepted
                    ? {
                        preDelivery: {
                            accept: ({ turnId }) => input.onAccepted?.({ turnId }),
                        },
                    }
                    : {}),
            });
        },
    };
}
/**
 * Records only the two decisions a support reader cannot reconstruct from the
 * interface: a tail still holding the Turn for the user, and rule 1 overriding
 * such a tail because the previous Turn failed.
 */
function logWaitDecision(logger, input) {
    if (!logger)
        return;
    const tail = continuationTailWait(input.messages);
    const fields = {
        session_id: input.sessionId,
        tail_tool_name: tail?.toolName,
        waiting_for_user: tail?.waitingForUser,
        // The previous Turn's terminal outcome, not the Session status field.
        previous_turn_outcome: input.terminal?.outcome ?? 'unknown',
        tail_turn_id: input.tailTurnId,
        previous_turn_id: input.terminal?.turnId,
    };
    if (input.state === 'waiting-for-user') {
        logger.info(fields, 'Turn continuation is waiting for the user');
        return;
    }
    if (input.previousTurnFailed && tail?.waiting === true) {
        logger.info(fields, 'Turn continuation ignored the user wait after a failed Turn');
    }
}
//# sourceMappingURL=turn-continuation.service.js.map