export class SessionDiffServiceError extends Error {
    reason;
    sessionId;
    constructor(reason, sessionId) {
        super(reason === 'session-not-found'
            ? `Session not found: ${sessionId}`
            : 'Legacy opencode Session diff is unavailable through the v2 Diff owner.');
        this.reason = reason;
        this.sessionId = sessionId;
        this.name = 'SessionDiffServiceError';
    }
}
/** Owns eligibility only. Diff capture/query/revert/reapply storage remains external. */
export class SessionDiffService {
    sessions;
    constructor(sessions) {
        this.sessions = sessions;
    }
    async requireTarget(sessionId) {
        const session = await this.sessions.get(sessionId);
        if (!session)
            throw new SessionDiffServiceError('session-not-found', sessionId);
        if (session.runtime === 'opencode') {
            throw new SessionDiffServiceError('runtime-unsupported', sessionId);
        }
        return { sessionId: session.sessionId, workspaceDir: session.workspaceDir };
    }
}
//# sourceMappingURL=service.js.map