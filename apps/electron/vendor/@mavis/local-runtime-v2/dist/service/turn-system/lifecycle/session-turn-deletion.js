import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import {} from './session-operation-gate.js';
export function createSessionTurnDeletionService(options) {
    const lane = new KeyedOperationLane();
    return {
        run: (sessionId, cleanup) => lane.run(sessionId, async () => {
            const gate = await options.beginProcessDeletion(sessionId);
            if (gate.status === 'not-found') {
                await options.repository.completeSessionDeletion(sessionId);
                options.operations.release(sessionId);
                return;
            }
            const operationDrain = options.operations.block(sessionId);
            const dispatchDrain = options.dispatcher.quiesceSession(sessionId);
            await options.repository.beginSessionDeletion(sessionId);
            await Promise.all([operationDrain, dispatchDrain]);
            await requireQuiescentTurn(options, sessionId);
            await options.disposeRuntimeSession(sessionId);
            await options.repository.deleteSessionData(sessionId);
            await cleanup();
            await options.repository.completeSessionDeletion(sessionId);
            options.completeProcessDeletion(sessionId);
            options.operations.release(sessionId);
        }),
    };
}
async function requireQuiescentTurn(options, sessionId) {
    const activeTurnId = options.controller.activeTurnId(sessionId);
    const abort = await options.controller.abort({
        sessionId,
        ...(activeTurnId ? { turnId: activeTurnId } : {}),
        reason: 'session-delete',
    });
    if (abort.status === 'abort-timeout') {
        throw new Error(`Active Turn did not release before Session deletion: ${sessionId}/${abort.turnId}`);
    }
    const durable = await options.repository.readSessionDeletion(sessionId);
    const remainingTurnId = options.controller.activeTurnId(sessionId);
    if (durable.status === 'active' || remainingTurnId) {
        throw new Error(`Active Turn did not reach deletion quiescence: ${sessionId}/${durable.status === 'active' ? durable.turnId : remainingTurnId}`);
    }
    if (durable.status !== 'quiescent') {
        throw new Error(`Turn deletion lock was lost: ${sessionId}`);
    }
}
//# sourceMappingURL=session-turn-deletion.js.map