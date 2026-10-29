export function createRuntimeGoalPort(goal) {
    const goals = goal.service;
    return {
        deleteSession: async (sessionId) => {
            const current = await goals.store.getBySession(sessionId);
            if (!current)
                return;
            await goals.store.delete(current.goalId);
            goals.handleChanged({ type: 'deleted', goalId: current.goalId, sessionId });
        },
        getBySession: async (sessionId) => {
            const current = await goals.store.getBySession(sessionId);
            return current ? { goalId: current.goalId, status: current.status } : undefined;
        },
        classifyQueuedItem: (item, hasPendingPlan) => goals.classifyQueuedItem(item, hasPendingPlan),
        prepareTurnAdmission: (input) => goals.prepareTurnAdmission(input),
        pauseActiveForAbort: (sessionId) => goals.pauseActiveGoalForAbort(sessionId),
        goalIdForTurn: (sessionId, turnId) => goals.goalIdForTurn(sessionId, turnId),
        takeDetachedTurn: (sessionId, turnId) => goals.takeDetachedTurn(sessionId, turnId),
        followQueuedTurn: (input) => goals.transferSubSessionRound(input),
    };
}
//# sourceMappingURL=runtime-goal-port.js.map