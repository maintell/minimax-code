const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
export class SessionSourceQueryService {
    options;
    constructor(options) {
        this.options = options;
    }
    async list(input) {
        if (this.options.enabled === false) {
            return { sourcedTurnCount: 0, sourceCount: 0, recentSources: [], turns: [], hasMore: false };
        }
        await this.assertReadable(input.sessionId);
        const limit = normalizeLimit(input.limit);
        const beforeRowId = input.before ? decodeCursor(input.sessionId, input.before) : undefined;
        const page = await this.options.sources.list({
            sessionId: input.sessionId,
            limit,
            ...(beforeRowId !== undefined ? { beforeRowId } : {}),
        });
        const last = page.turns.at(-1);
        return {
            sourcedTurnCount: page.sourcedTurnCount,
            sourceCount: page.sourceCount,
            recentSources: page.recentSources,
            turns: page.turns.map(({ cursorRowId: _, ...turn }) => turn),
            hasMore: page.hasMore,
            ...(page.hasMore && last
                ? { nextCursor: encodeCursor(input.sessionId, last.cursorRowId) }
                : {}),
        };
    }
    async getToolDetail(sessionId, messageId, toolCallId) {
        if (this.options.enabled === false)
            return undefined;
        await this.assertReadable(sessionId);
        if (!(await this.options.sources.hasOccurrence(sessionId, messageId, toolCallId))) {
            return undefined;
        }
        const message = await this.options.messages.get(sessionId, messageId);
        const toolCall = message ? findToolCall(message, toolCallId) : undefined;
        return toolCall ? { messageId, toolCall } : undefined;
    }
    async assertReadable(sessionId) {
        await this.options.readiness?.ensureDisplayReady(sessionId);
        if (!(await this.options.sessions.get(sessionId))) {
            throw new SessionSourceQueryServiceError('session-not-found', sessionId);
        }
    }
}
export class SessionSourceQueryServiceError extends Error {
    reason;
    sessionId;
    constructor(reason, sessionId) {
        super(reason === 'session-not-found'
            ? `Session not found: ${sessionId}`
            : `Invalid Session source history cursor: ${sessionId}`);
        this.reason = reason;
        this.sessionId = sessionId;
        this.name = 'SessionSourceQueryServiceError';
    }
}
function normalizeLimit(value) {
    if (value === undefined)
        return DEFAULT_LIMIT;
    if (!Number.isInteger(value) || value <= 0)
        return DEFAULT_LIMIT;
    return Math.min(value, MAX_LIMIT);
}
function encodeCursor(sessionId, beforeRowId) {
    return Buffer.from(JSON.stringify({ v: 1, sessionId, beforeRowId })).toString('base64url');
}
function decodeCursor(sessionId, cursor) {
    try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!isRecord(value))
            throw new Error('invalid source cursor');
        if (value.v !== 1 || value.sessionId !== sessionId)
            throw new Error('invalid source cursor');
        if (!Number.isSafeInteger(value.beforeRowId) || Number(value.beforeRowId) <= 0) {
            throw new Error('invalid source cursor');
        }
        return Number(value.beforeRowId);
    }
    catch {
        throw new SessionSourceQueryServiceError('invalid-pagination', sessionId);
    }
}
function findToolCall(message, toolCallId) {
    let direct = [];
    if (Array.isArray(message.tool_calls))
        direct = message.tool_calls;
    else if (Array.isArray(message.toolCalls))
        direct = message.toolCalls;
    const parts = Array.isArray(message.parts)
        ? message.parts.flatMap((part) => {
            if (!isRecord(part) || part.type !== 'tool_call')
                return [];
            return [part.tool_call ?? part.toolCall].filter(isRecord);
        })
        : [];
    return [...direct, ...parts].find((value) => {
        if (!isRecord(value))
            return false;
        return readString(value.id ?? value.tool_call_id ?? value.toolCallId) === toolCallId;
    });
}
function readString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=session-source-query-service.js.map