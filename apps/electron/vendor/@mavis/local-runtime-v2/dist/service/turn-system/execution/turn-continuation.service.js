import { inspectContinuationHistory } from '../agent-host/history/continuation-history.js';
export function createTurnContinuationService(options) {
    const inspect = async (sessionId) => {
        if (options.execution.activeTurnId(sessionId))
            return { state: 'running' };
        const history = await options.history.inspectActive(sessionId);
        return { state: inspectContinuationHistory(history.messages) };
    };
    return {
        inspect,
        continueTurn: async (input) => {
            const inspection = await inspect(input.sessionId);
            if (inspection.state === 'running')
                return { accepted: false, reason: 'active-turn' };
            if (inspection.state !== 'available') {
                return { accepted: false, reason: inspection.state };
            }
            return options.execution.submit({
                sessionId: input.sessionId,
                input: { text: '' },
                genuineUserQueryText: '',
                provenance: {
                    source: 'turn-continuation',
                    routingFingerprint: `turn-continuation:${input.sessionId}`,
                },
                clientIntent: 'turn-continuation',
                admissionPriority: { kind: 'turn-continuation' },
                executionMode: 'continuation',
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
//# sourceMappingURL=turn-continuation.service.js.map