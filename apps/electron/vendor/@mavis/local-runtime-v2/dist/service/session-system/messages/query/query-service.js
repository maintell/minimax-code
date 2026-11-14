import { isNavigableUserInput, projectNavigationText } from '../input-navigation/text.js';
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
    async recentUserInputs(sessionId, options = {}) {
        // Bound work even when a conversation contains many synthetic user messages.
        const page = await this.read({ sessionId }, 32, true, 'user');
        const recent = page.messages.filter((message) => (message.timestamp ?? message.created_at ?? 0) >= (options.since ?? 0));
        return recent
            .filter(isNavigableUserInput)
            .filter((message) => !message.source || message.source === 'api')
            .map(projectNavigationText)
            .filter((text) => text.trim() &&
            !/^(?:ok|okay|yes|thanks|continue|retry|好|好的|是|收到|明白|谢谢|继续|重试)[.!。！\s]*$/iu.test(text.trim()))
            .slice(-4)
            .map((text) => text.slice(0, 1500));
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
    async read(input, limit, visibleOnly = false, role) {
        await this.options.readiness?.ensureDisplayReady(input.sessionId);
        const session = await this.options.sessions.get(input.sessionId);
        if (!session) {
            throw new MessageQueryServiceError('session-not-found', `Session not found: ${input.sessionId}`);
        }
        try {
            const afterMessageId = visibleOnly ? this.visibleBoundary(session) : undefined;
            const page = await this.options.messages.list(input.sessionId, {
                limit,
                role,
                ...(input.before ? { before: input.before } : {}),
                ...(input.systemEventsOnly ? { systemEventsOnly: true } : {}),
                ...(afterMessageId ? { afterMessageId } : {}),
            });
            return messageQueryPage(page);
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
function messageQueryPage(page) {
    return {
        messages: page.messages,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        hasMore: page.hasMore,
        ...(page.rowStats ? { rowStats: page.rowStats } : {}),
    };
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