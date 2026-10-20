import { isCloudSessionRead, readCloudSession } from './session-read-source.js';
import { logger } from '@mavis/shared/local-runtime-logging';
import { SessionQueryServiceError, } from '../../service/session-system/index.js';
import { AppError } from '../errors.js';
import { toSessionInfoView, toSessionTreeChildView } from './wire.js';
/** Maps generated Session query contracts directly to the neutral Session read service. */
export class SessionQueryApplication {
    options;
    constructor(options) {
        this.options = options;
    }
    async listSessions(_context, req) {
        const page = await this.invoke(() => this.options.service.list({
            agentName: req.name,
            includeArchived: req.includeArchived,
            onlyArchived: req.onlyArchived,
            onlyCompressed: req.onlyCompressed,
            includeHidden: req.includeHidden,
            includePurposePrefix: req.includePurposePrefix,
            excludePurposePrefix: req.excludePurposePrefix,
            limit: req.limit,
            offset: req.offset,
            cursor: req.cursor,
        }));
        return {
            sessions: page.sessions.map((session) => toSessionInfoView(session, this.options.sideChats.relation(session.sessionId))),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async searchSessions(_context, req) {
        const page = await this.invoke(() => this.options.service.search({
            keyword: req.keyword,
            agentName: req.agentName,
            limit: req.limit,
            cursor: req.cursor,
        }));
        return {
            sessions: page.sessions.map((session) => toSessionInfoView(session, this.options.sideChats.relation(session.sessionId))),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async getSessionTree(_context, req) {
        const page = await this.invoke(() => this.options.service.tree({
            agentName: req.name,
            includeArchived: req.includeArchived,
            onlyArchived: req.onlyArchived,
            onlyCompressed: req.onlyCompressed,
            includeHidden: req.includeHidden,
            includePurposePrefix: req.includePurposePrefix,
            excludePurposePrefix: req.excludePurposePrefix,
            limit: req.limit,
            cursor: req.cursor,
        }));
        return {
            sessions: page.sessions.map(({ session, children }) => ({
                session: toSessionInfoView(session, this.options.sideChats.relation(session.sessionId)),
                childSessions: children.map(toSessionTreeChildView),
            })),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async getSession(_context, req) {
        if (isCloudSessionRead(req.source))
            return readCloudSession(this.options.cloudReader
                ? () => this.options.cloudReader.getSession(req.id, _context.signal)
                : undefined);
        const session = await this.invoke(() => this.options.service.get(req.id));
        const page = req.includeSideChats
            ? this.options.sideChats.list(req.id, {
                limit: req.sideChatsLimit,
                cursor: req.sideChatsCursor,
            })
            : undefined;
        return {
            session: toSessionInfoView(session, this.options.sideChats.relation(session.sessionId)),
            ...(page
                ? {
                    sideChats: {
                        items: page.sessions.map((side) => toSessionInfoView(side, this.options.sideChats.relation(side.sessionId))),
                        hasMore: page.hasMore,
                        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
                    },
                }
                : {}),
        };
    }
    /**
     * Serves the sidebar's cross-Agent Recents page for local(daemon).
     *
     * This used to throw NotImplemented because only Cloud (archon-biz) had an
     * all-Agent projection, which is why Desktop's sidebar only ever showed the
     * primary Agent's Sessions. The contract, HTTP route and generated client
     * already existed on both sides, so no IDL change was needed — only the
     * local implementation was missing.
     */
    async getSidebarSessionTree(_context, req) {
        if (req.projectId !== undefined) {
            // Cloud uses projectId to carve Project Sessions out of Recents
            // server-side. Local keeps Project membership in the client store and
            // filters there, so honouring it here would double-filter. Logged rather
            // than silently dropped so an unexpected caller is traceable.
            logger.info({ projectId: req.projectId }, '[local-runtime-v2] sidebar tree ignoring projectId (local filters Project Sessions client-side)');
        }
        const page = await this.invoke(() => this.options.service.sidebarTree({
            limit: req.limit,
            cursor: req.cursor,
        }));
        // Owner distribution is the whole point of this endpoint, so log it: a page
        // that collapses back to a single Agent means the cross-Agent predicate
        // regressed.
        logger.info({
            limit: req.limit,
            cursor: req.cursor,
            returned: page.sessions.length,
            hasMore: page.hasMore,
            agentNames: [...new Set(page.sessions.map(({ session }) => session.agentName))],
        }, '[local-runtime-v2] sidebar tree page served');
        return {
            sessions: page.sessions.map(({ session, children }) => ({
                session: toSessionInfoView(session, this.options.sideChats.relation(session.sessionId)),
                childSessions: children.map(toSessionTreeChildView),
            })),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async invoke(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (error instanceof SessionQueryServiceError) {
                const mapping = queryFailureMapping(error.reason);
                throw new AppError(mapping.status, mapping.key, error.message);
            }
            throw error;
        }
    }
}
function queryFailureMapping(reason) {
    switch (reason) {
        case 'session-not-found':
            return { status: 404, key: 'SESSION_NOT_FOUND' };
    }
}
//# sourceMappingURL=query-application.js.map