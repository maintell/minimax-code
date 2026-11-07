import { MessageDataCorruptionError } from '../repo/contract.js';
const DEFAULT_MESSAGE_PAGE_SIZE = 80;
export class MessageQueryServiceError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'MessageQueryServiceError';
    }
}
export class MessageQueryService {
    options;
    defaultPageSize;
    constructor(options) {
        this.options = options;
        this.defaultPageSize = normalizeDefaultPageSize(options.defaultPageSize);
    }
    async list(input) {
        return this.read(input, normalizeRequestedLimit(input.limit, this.defaultPageSize), true);
    }
    async listExact(input) {
        return this.read(input, input.limit);
    }
    async listAfter(sessionId, afterMsgId) {
        await this.options.readiness?.ensureDisplayReady(sessionId);
        const session = await this.options.sessions.get(sessionId);
        if (!session)
            throw new MessageQueryServiceError('session-not-found', `Session not found: ${sessionId}`);
        return this.options.messages.listAfter(sessionId, afterMsgId, this.visibleBoundary(session));
    }
    async read(input, limit, visibleOnly = false) {
        await this.options.readiness?.ensureDisplayReady(input.sessionId);
        const session = await this.options.sessions.get(input.sessionId);
        if (!session) {
            throw new MessageQueryServiceError('session-not-found', `Session not found: ${input.sessionId}`);
        }
        try {
            const afterMessageId = visibleOnly ? this.visibleBoundary(session) : undefined;
            const page = await this.options.messages.list(input.sessionId, {
                ...(limit !== undefined ? { limit } : {}),
                ...(input.before ? { before: input.before } : {}),
                ...(afterMessageId ? { afterMessageId } : {}),
            });
            return {
                messages: page.messages,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                hasMore: page.hasMore,
            };
        }
        catch (error) {
            if (error instanceof MessageDataCorruptionError) {
                throw new MessageQueryServiceError('data-corrupt', error.message);
            }
            throw error;
        }
    }
    visibleBoundary(session) {
        if (!this.options.sideChats.relation(session.sessionId))
            return undefined;
        if (!session.sideChatOrigin) {
            throw new MessageQueryServiceError('data-corrupt', `Side origin missing: ${session.sessionId}`);
        }
        return session.sideChatOrigin.inheritedThroughMessageId;
    }
}
function normalizeDefaultPageSize(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_MESSAGE_PAGE_SIZE;
    }
    return Math.max(1, Math.floor(value));
}
function normalizeRequestedLimit(value, defaultPageSize) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.floor(value))
        : defaultPageSize;
}
//# sourceMappingURL=query-service.js.map