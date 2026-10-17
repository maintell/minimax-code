/** Keeps every Session-aware Agent snapshot read on the same immutable Task policy. */
export function readSessionAgentExecutionSnapshot(agents, session) {
    return agents.getExecutionSnapshot(session.agentName, {
        sessionId: session.sessionId,
        ...(session.appMode ? { appMode: session.appMode } : {}),
        sessionKind: session.sessionKind,
    });
}
//# sourceMappingURL=session-agent-execution-snapshot.js.map