export function requireAgentRuntime(lifecycle) {
    if (!lifecycle)
        throw new Error('AgentHost runtime lifecycle was not initialized.');
    return lifecycle;
}
export function requireHarnessHistory(history) {
    if (!history)
        throw new Error('Harness history was not initialized.');
    return history;
}
export function requireTurnSystem(owner) {
    if (!owner)
        throw new Error('TurnSystem is not initialized.');
    return owner;
}
//# sourceMappingURL=runtime-initialization-guards.js.map