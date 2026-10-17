export function createConversationMutationState(db, operations) {
    let planStateReader;
    return {
        isActive: (sessionId) => operations.blocksSessionInTransaction(db, sessionId),
        readPlanState: async (sessionId) => (await planStateReader?.(sessionId)) ?? {
            active: false,
            interactionMode: undefined,
            lifecycleActive: false,
        },
        bindPlanStateReader: (next) => {
            planStateReader = next;
        },
    };
}
//# sourceMappingURL=conversation-mutation-state.js.map