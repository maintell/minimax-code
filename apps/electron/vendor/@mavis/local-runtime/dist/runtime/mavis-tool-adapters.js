import { sendToLocalSession } from './mavis-session-send.js';
export { buildMavisCronAdapter } from './mavis-cron-adapter.js';
export function buildMavisSessionAdapter(deps) {
    return {
        listSessions: async (req) => {
            const archived = req.archiveFilter === 'Archived'
                ? true
                : req.archiveFilter === 'Unarchived'
                    ? false
                    : undefined;
            const scope = req.agentName && deps.resolveAgentReadScope
                ? await deps.resolveAgentReadScope(req.agentName)
                : undefined;
            const sessions = (await deps.listAllSessions(scope ? undefined : req.agentName, {
                archived,
                ...(scope ? { agentNames: scope.compatibleNames } : {}),
            })).filter((session) => req.parentSessionId === undefined || session.parentSessionId === req.parentSessionId);
            const page = pageBySessionCursor(sessions, req.cursor, req.limit);
            return {
                sessions: await deps.serializeSessions(page.items),
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        },
        getSession: async (req, signal) => {
            if (req.source === 'cloud') {
                if (!deps.cloudReader)
                    throw new Error('Cloud session reading is unavailable on this host');
                return deps.cloudReader.getSession(req.sessionId, signal);
            }
            const session = await deps.getSessionById(req.sessionId);
            return { ...(session ? { session: await deps.serializeSession(session) } : {}) };
        },
        updateSession: async (req) => {
            const current = await deps.getSessionById(req.sessionId);
            if (!current) {
                throw Object.assign(new Error(`Session not found: ${req.sessionId}`), {
                    status: 404,
                    code: 'SESSION_NOT_FOUND',
                });
            }
            const updated = await deps.updateSession(req.sessionId, {
                ...(Object.hasOwn(req, 'title') ? { title: req.title } : {}),
                ...(Object.hasOwn(req, 'archived') ? { archived: req.archived } : {}),
            });
            return { session: await deps.serializeSession(updated ?? current), success: true };
        },
        deleteSession: async (req) => {
            const session = await deps.getSessionById(req.sessionId);
            if (!session) {
                throw Object.assign(new Error(`Session not found: ${req.sessionId}`), {
                    status: 404,
                    code: 'SESSION_NOT_FOUND',
                });
            }
            await deps.deleteSession(req.sessionId);
            await deps.deleteMessageState(req.sessionId);
            await deps.deleteQueuedMessages(req.sessionId);
            await deps.markMigratedLegacySessionDeleted(req.sessionId);
            deps.clearRootSessionIf(req.sessionId);
            return { success: true };
        },
        listMessages: async (req, signal) => {
            if (req.source === 'cloud') {
                if (!deps.cloudReader)
                    throw new Error('Cloud session reading is unavailable on this host');
                return deps.cloudReader.getMessages(req.sessionId, req, signal);
            }
            const page = await deps.listDisplayMessages(req.sessionId, {
                ...(req.limit !== undefined ? { limit: req.limit } : {}),
                ...(req.before ? { before: req.before } : {}),
            });
            return {
                messages: page.messages,
                hasMore: page.hasMore,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
            };
        },
        sendSession: (req, signal) => sendToLocalSession(deps, req, signal),
    };
}
function pageBySessionCursor(items, cursor, limit) {
    const start = cursor === undefined
        ? 0
        : Math.max(0, items.findIndex((item) => item.sessionId === cursor) + 1);
    return pageItems(items.slice(start), limit, (item) => item.sessionId);
}
function pageItems(items, limit, cursorFor) {
    if (limit === undefined || limit <= 0)
        return { items, hasMore: false };
    const page = items.slice(0, limit);
    const hasMore = items.length > limit;
    const lastItem = page.at(-1);
    const nextCursor = hasMore && lastItem ? cursorFor(lastItem) : undefined;
    return {
        items: page,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
    };
}
//# sourceMappingURL=mavis-tool-adapters.js.map