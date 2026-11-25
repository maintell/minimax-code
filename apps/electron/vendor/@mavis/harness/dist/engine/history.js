import { continuationTailTurnId, continuationTailWait, inspectContinuationHistory, } from '../agent-host/history/continuation-history.js';
import { forkHistory, inspectHistoryForkBoundary, rewindHistory, } from './history/history-mutation.js';
export function createHarnessHistory() {
    return {
        inspectContinuation: async (input) => {
            const snapshot = await input.history.inspect(input.sessionId);
            const tailTurnId = continuationTailTurnId(snapshot.messages, snapshot.turnIdVector);
            const tailWait = continuationTailWait(snapshot.messages);
            const state = inspectContinuationHistory(snapshot.messages, {
                ...(input.failedTurnId !== undefined
                    ? { previousTurnFailed: true, failedTurnId: input.failedTurnId }
                    : {}),
                ...(tailTurnId !== undefined ? { tailTurnId } : {}),
            });
            return {
                state,
                historyRevision: snapshot.revision,
                ...(tailWait ? { tailWait } : {}),
                ...(tailTurnId !== undefined ? { tailTurnId } : {}),
            };
        },
        rewind: rewindHistory,
        fork: forkHistory,
        inspectForkBoundary: inspectHistoryForkBoundary,
    };
}
//# sourceMappingURL=history.js.map