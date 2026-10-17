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
        return this.read(input, normalizeRequestedLimit(input.limit, this.defaultPageSize));
    }
    async listExact(input) {
        return this.read(input, input.limit);
    }
    async read(input, limit) {
        await this.options.readiness?.ensureDisplayReady(input.sessionId);
        if (!(await this.options.sessions.get(input.sessionId))) {
            throw new MessageQueryServiceError('session-not-found', `Session not found: ${input.sessionId}`);
        }
        try {
            const page = await this.options.messages.list(input.sessionId, {
                ...(limit !== undefined ? { limit } : {}),
                ...(input.before ? { before: input.before } : {}),
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