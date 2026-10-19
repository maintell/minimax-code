import { captureSemanticSnapshot } from '../history/semantic-identity.js';
export class AgentHostSessionReadError extends Error {
    sessionId;
    reason;
    name = 'AgentHostSessionReadError';
    constructor(sessionId, reason) {
        super(`AgentHost Session read failed for "${sessionId}": ${reason}.`);
        this.sessionId = sessionId;
        this.reason = reason;
    }
}
export function captureAgentHostSession(expectedSessionId, session) {
    if (!session)
        throw new AgentHostSessionReadError(expectedSessionId, 'not-found');
    const snapshot = captureSemanticSnapshot(session).value;
    if (snapshot.sessionId !== expectedSessionId) {
        throw new AgentHostSessionReadError(expectedSessionId, 'identity');
    }
    if (!isNonEmptyString(snapshot.agentName)) {
        throw new AgentHostSessionReadError(expectedSessionId, 'agent-name');
    }
    if (!isNonEmptyString(snapshot.workspaceDir)) {
        throw new AgentHostSessionReadError(expectedSessionId, 'workspace-dir');
    }
    if (snapshot.sessionType !== 'root' && snapshot.sessionType !== 'branch') {
        throw new AgentHostSessionReadError(expectedSessionId, 'session-type');
    }
    return snapshot;
}
function isNonEmptyString(value) {
    return typeof value === 'string' && Boolean(value.trim());
}
//# sourceMappingURL=session-read.js.map