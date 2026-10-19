export class PeekContextServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'PeekContextServiceError';
    }
}
export class PeekContextService {
    options;
    constructor(options) {
        this.options = options;
    }
    async getContext(sessionId) {
        await this.options.readiness?.ensureDisplayReady(sessionId);
        const session = await this.options.sessions.get(sessionId);
        if (!session) {
            throw new PeekContextServiceError('session-not-found', `Session not found: ${sessionId}`);
        }
        const related = await this.collectRelatedSessions(session);
        const sections = await Promise.all(related.map((item) => this.formatSession(item, item.sessionId === session.sessionId)));
        return sections.join('\n\n');
    }
    async collectRelatedSessions(session) {
        const byId = new Map();
        let current = session;
        while (current && !byId.has(current.sessionId)) {
            byId.set(current.sessionId, current);
            current = current.parentSessionId
                ? await this.options.sessions.get(current.parentSessionId)
                : undefined;
        }
        const children = await this.options.sessions.listChildren(session.sessionId);
        children
            .filter((child) => !child.archived && child.visibility !== 'hidden')
            .forEach((child) => byId.set(child.sessionId, child));
        return [...byId.values()];
    }
    async formatSession(session, alreadyReady = false) {
        if (!alreadyReady)
            await this.options.readiness?.ensureDisplayReady(session.sessionId);
        const messages = await this.options.messages.listRecent(session.sessionId, { limit: 6 });
        const lines = messages
            .map(formatPeekMessage)
            .filter((line) => line !== undefined);
        return [
            `## ${session.title || session.sessionId}`,
            `sessionId: ${session.sessionId}`,
            `role: ${session.parentSessionId ? 'child' : 'root'}`,
            ...(lines.length > 0 ? lines : ['(no recent messages)']),
        ].join('\n');
    }
}
function formatPeekMessage(message) {
    const content = typeof message.msg_content === 'string'
        ? message.msg_content
        : safeJsonStringify(message.msg_content);
    if (!content)
        return undefined;
    const role = peekMessageRole(message.role);
    return `${role}: ${content.slice(0, 2_000)}`;
}
function peekMessageRole(role) {
    if (role === 'user')
        return 'user';
    if (role === 'assistant')
        return 'assistant';
    return 'system';
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=peek-context-service.js.map