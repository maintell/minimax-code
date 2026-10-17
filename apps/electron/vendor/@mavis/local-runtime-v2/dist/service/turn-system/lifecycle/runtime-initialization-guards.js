export function requireAgentRuntime(lifecycle) {
    if (!lifecycle)
        throw new Error('AgentHost runtime lifecycle was not initialized.');
    return lifecycle;
}
export function requireTurnSystem(owner) {
    if (!owner)
        throw new Error('TurnSystem is not initialized.');
    return owner;
}
//# sourceMappingURL=runtime-initialization-guards.js.map