export function createTurnContinuationService(options) {
    const history = { inspect: (sessionId) => options.history.inspectActive(sessionId) };
    const decide = async (sessionId) => {
        if (options.execution.activeTurnId(sessionId)) {
            return { state: 'running', previousTurnFailed: false };
        }
        const terminal = await options.previousTurn.readTerminal(sessionId);
        const failedTurnId = terminal?.outcome === 'failed' ? terminal.turnId : undefined;
        const inspection = await options.harness.inspectContinuation({
            sessionId,
            history,
            ...(failedTurnId !== undefined ? { failedTurnId } : {}),
        });
        const previousTurnFailed = failedTurnId !== undefined;
        logWaitDecision(options.logger, { sessionId, terminal, previousTurnFailed, inspection });
        // Keep the source of the input being resumed, never the last IM chat used
        // by this Session. Repeated retries may have no new user message.
        const snapshot = await options.history.inspectActive(sessionId);
        let continuedFromTurnId;
        for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
            const message = snapshot.messages[index];
            if (typeof message === 'object' &&
                message !== null &&
                'role' in message &&
                message.role === 'user') {
                continuedFromTurnId = snapshot.turnIdVector?.[index];
                break;
            }
        }
        return {
            state: inspection.state,
            previousTurnFailed,
            ...(continuedFromTurnId ? { continuedFromTurnId } : {}),
        };
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
    const tail = input.inspection.tailWait;
    const fields = {
        session_id: input.sessionId,
        tail_tool_name: tail?.toolName,
        waiting_for_user: tail?.waitingForUser,
        // The previous Turn's terminal outcome, not the Session status field.
        previous_turn_outcome: input.terminal?.outcome ?? 'unknown',
        tail_turn_id: input.inspection.tailTurnId,
        previous_turn_id: input.terminal?.turnId,
    };
    if (input.inspection.state === 'waiting-for-user') {
        logger.info(fields, 'Turn continuation is waiting for the user');
        return;
    }
    if (input.previousTurnFailed && tail?.waiting === true) {
        logger.info(fields, 'Turn continuation ignored the user wait after a failed Turn');
    }
}
//# sourceMappingURL=turn-continuation.service.js.map