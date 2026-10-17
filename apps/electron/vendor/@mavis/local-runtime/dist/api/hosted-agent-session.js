export function toLocalSessionRecord(session) {
    return {
        sessionId: session.sessionId,
        agentName: session.agentName,
        workspaceDir: session.workspaceDir,
        runtime: 'pi-agent',
        sessionType: session.sessionType,
        ...(session.sessionKind !== undefined ? { sessionKind: session.sessionKind } : {}),
        archived: session.archived,
        status: session.status,
        createdAtMs: session.createdAtMs,
        updatedAtMs: session.updatedAtMs,
        ...(session.isDefaultWorkspace !== undefined
            ? { isDefaultWorkspace: session.isDefaultWorkspace }
            : {}),
        ...(session.title !== undefined ? { title: session.title } : {}),
        ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
        ...(session.visibility ? { visibility: session.visibility } : {}),
        ...(session.purpose ? { purpose: session.purpose } : {}),
        ...(session.runLocation ? { runLocation: session.runLocation } : {}),
        ...(session.appMode ? { appMode: session.appMode } : {}),
        ...(session.effectiveModel !== undefined ? { effectiveModel: session.effectiveModel } : {}),
        ...(session.effectiveModelVariant !== undefined
            ? { effectiveModelVariant: session.effectiveModelVariant }
            : {}),
        ...(session.scratchpadPath ? { scratchpadPath: session.scratchpadPath } : {}),
    };
}
//# sourceMappingURL=hosted-agent-session.js.map