import { HTTPException } from 'hono/http-exception';
import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';
import { appendSearchParam, asArray, asObject, encodeSegment, mapFileDiffInfoView, mapSessionMessageView, mapOptionalSessionInfoView, mapSessionInfoView, mapSessionTreeNodeView, mapTokenUsageRowView, mapTokenUsageSummaryView, mapTurnDiffFields, mapTurnDiffView, toCreateSessionBody, toSendMessageBody, } from './desktop-session-mappers.js';
import { readString } from './desktop-session-mapper-support.js';
import { jsonError } from './desktop-service-support.js';
import { requestLocalSessionCompaction } from './desktop-session-agent-actions.js';
import { deleteLocalQueueItem, enqueueLocalMessage, getLocalQueueItem, listLocalQueueMessages, reorderLocalQueue, updateLocalQueueItem, } from './desktop-session-queue.js';
import { openLocalSessionStream } from './desktop-session-stream.js';
const LOCAL_RUNTIME_ORIGIN = 'http://local-runtime.test';
const LOCAL_API_BASE = `${LOCAL_RUNTIME_ORIGIN}/mavis/api/`;
export class DesktopSessionService {
    localApiJson;
    localApiResponse;
    metricsClient;
    constructor(localApiJson, localApiResponse, 
    /** Optional sink for `builtin_command_total` / `session_lifecycle_total`; absent = noop. */
    metricsClient) {
        this.localApiJson = localApiJson;
        this.localApiResponse = localApiResponse;
        this.metricsClient = metricsClient;
    }
    /**
     * Count a desktop builtin command (`new` / `compact`) around its local-api
     * call. `localApiJson` throws HTTPException on any non-2xx, so
     * resolve = succeeded / throw = failed is accurate at this boundary.
     */
    async countBuiltinCommand(command, run) {
        this.metricsClient?.counter('builtin_command_total', 1, { command, status: 'started' });
        try {
            const result = await run();
            this.metricsClient?.counter('builtin_command_total', 1, { command, status: 'succeeded' });
            return result;
        }
        catch (err) {
            this.metricsClient?.counter('builtin_command_total', 1, { command, status: 'failed' });
            throw err;
        }
    }
    countSessionLifecycle(action, status) {
        this.metricsClient?.counter('session_lifecycle_total', 1, { action, status });
    }
    /**
     * Count a session lifecycle action around its local-api call. `localApiJson`
     * throws HTTPException on any non-2xx, so resolve = ok / throw = error is
     * accurate at this boundary. The SSE-based `resume` path resolves with an
     * explicit `ok` flag instead of throwing and is counted inline.
     */
    async withSessionLifecycle(action, run) {
        try {
            const result = await run();
            this.countSessionLifecycle(action, 'ok');
            return result;
        }
        catch (err) {
            this.countSessionLifecycle(action, 'error');
            throw err;
        }
    }
    async searchSessions(ctx, req) {
        void ctx;
        const url = new URL('session/search', LOCAL_API_BASE);
        appendSearchParam(url, 'keyword', req.keyword);
        appendSearchParam(url, 'limit', req.limit);
        appendSearchParam(url, 'agentName', req.agentName);
        appendSearchParam(url, 'agent_name', req.agentName);
        appendSearchParam(url, 'cursor', req.cursor);
        const body = await this.localApiJson(url);
        return {
            sessions: asArray(body.sessions).map(mapSessionInfoView),
            hasMore: body.hasMore ?? body.has_more,
            nextCursor: body.nextCursor ?? body.next_cursor,
        };
    }
    async getRootSession(ctx, req) {
        void ctx;
        const body = await this.localApiJson(`agent/${encodeSegment(req.name)}/session/root`);
        return { session: mapOptionalSessionInfoView(body.session) };
    }
    async replaceRootSession(ctx, req) {
        void ctx;
        return this.localApiJson(`agent/${encodeSegment(req.name)}/session/root`, {
            method: 'PUT',
            body: { sessionId: req.sessionId, session_id: req.sessionId },
        });
    }
    async listSessions(ctx, req) {
        void ctx;
        const url = new URL(`agent/${encodeSegment(req.name)}/session`, LOCAL_API_BASE);
        appendSearchParam(url, 'limit', req.limit);
        appendSearchParam(url, 'offset', req.offset);
        appendSearchParam(url, 'cursor', req.cursor);
        appendSearchParam(url, 'include_archived', req.includeArchived);
        appendSearchParam(url, 'only_archived', req.onlyArchived);
        appendSearchParam(url, 'onlyCompressed', req.onlyCompressed);
        appendSearchParam(url, 'excludePurposePrefix', req.excludePurposePrefix);
        appendSearchParam(url, 'includePurposePrefix', req.includePurposePrefix);
        appendSearchParam(url, 'includeHidden', req.includeHidden);
        const body = await this.localApiJson(url);
        return {
            sessions: asArray(body.sessions).map(mapSessionInfoView),
            hasMore: body.hasMore ?? body.has_more,
            nextCursor: body.nextCursor ?? body.next_cursor,
        };
    }
    async createSession(ctx, req) {
        if (req.projectId !== undefined && req.projectId !== 0) {
            throw new HTTPException(400, {
                res: jsonError(400, 'project_id is not supported by desktop local-runtime', 'VALIDATION_ERROR'),
            });
        }
        return this.countBuiltinCommand('new', () => this.withSessionLifecycle('create', async () => {
            void ctx;
            const requestBody = toCreateSessionBody(req);
            const body = await this.localApiJson(`agent/${encodeSegment(req.name)}/session`, {
                method: 'POST',
                body: requestBody,
            });
            const session = mapOptionalSessionInfoView(body.session);
            const nestedData = asObject(body.data);
            const sessionId = readString(body.sessionId) ??
                readString(body.session_id) ??
                session?.sessionId ??
                readString(nestedData.sessionId) ??
                readString(nestedData.session_id);
            const agentName = readString(body.agentName) ?? readString(body.agent_name) ?? session?.agentName;
            return {
                ...(agentName ? { agentName } : {}),
                ...(sessionId ? { sessionId } : {}),
                ...(session ? { session } : {}),
            };
        }));
    }
    async getSessionTree(ctx, req) {
        void ctx;
        const url = new URL(`agent/${encodeSegment(req.name)}/session/tree`, LOCAL_API_BASE);
        appendSearchParam(url, 'limit', req.limit);
        appendSearchParam(url, 'cursor', req.cursor);
        appendSearchParam(url, 'include_archived', req.includeArchived);
        appendSearchParam(url, 'only_archived', req.onlyArchived);
        appendSearchParam(url, 'onlyCompressed', req.onlyCompressed);
        appendSearchParam(url, 'excludePurposePrefix', req.excludePurposePrefix);
        appendSearchParam(url, 'includePurposePrefix', req.includePurposePrefix);
        appendSearchParam(url, 'includeHidden', req.includeHidden);
        const body = await this.localApiJson(url);
        return {
            sessions: asArray(body.sessions).map(mapSessionTreeNodeView),
            hasMore: body.hasMore ?? body.has_more,
            nextCursor: body.nextCursor ?? body.next_cursor,
        };
    }
    async getSidebarSessionTree(ctx, req) {
        void ctx;
        void req;
        throw new HTTPException(501, {
            message: 'DesktopService.GetSidebarSessionTree is cloud-owned and is not implemented by local-runtime.',
        });
    }
    async getSession(ctx, req) {
        void ctx;
        const body = await this.localApiJson(`session/${encodeSegment(req.id)}`);
        return { session: mapOptionalSessionInfoView(body.session) };
    }
    async updateSession(ctx, req) {
        void ctx;
        const body = await this.localApiJson(`session/${encodeSegment(req.id)}`, {
            method: 'PATCH',
            body: {
                title: req.title,
                memory_policy: req.memoryPolicy
                    ? {
                        recall_enabled: req.memoryPolicy.recallEnabled,
                        write_enabled: req.memoryPolicy.writeEnabled,
                    }
                    : undefined,
            },
        });
        return { session: mapOptionalSessionInfoView(body.session) };
    }
    async getSessionUsage(ctx, req) {
        void ctx;
        const url = new URL(`session/${encodeSegment(req.id)}/usage`, LOCAL_API_BASE);
        appendSearchParam(url, 'from', req.fromMs);
        appendSearchParam(url, 'to', req.toMs);
        const body = await this.localApiJson(url);
        return {
            summary: mapTokenUsageSummaryView(body.summary),
            rows: asArray(body.rows).map(mapTokenUsageRowView),
        };
    }
    async getPeekContext(ctx, req) {
        void ctx;
        return this.localApiJson(`session/${encodeSegment(req.id)}/peek-context`);
    }
    async getSessionDiff(ctx, req) {
        void ctx;
        const url = new URL(`session/${encodeSegment(req.id)}/diff`, LOCAL_API_BASE);
        appendSearchParam(url, 'messageID', req.messageId);
        const body = await this.localApiJson(url);
        return {
            diffs: asArray(body.diffs).map(mapFileDiffInfoView),
            changeSetId: body.changeSetId ?? body.change_set_id,
        };
    }
    async deleteSession(ctx, req) {
        void ctx;
        return this.withSessionLifecycle('delete', () => this.localApiJson(`session/${encodeSegment(req.id)}`, {
            method: 'DELETE',
        }));
    }
    async archiveSession(ctx, req) {
        void ctx;
        return this.withSessionLifecycle(req.archived === false ? 'unarchive' : 'archive', () => this.localApiJson(`session/${encodeSegment(req.id)}/archive`, {
            method: 'POST',
            body: { archived: req.archived },
        }));
    }
    async compressSession(ctx, req) {
        void ctx;
        return this.localApiJson(`session/${encodeSegment(req.id)}/compress`, {
            method: 'POST',
            body: { archived: req.archived },
        });
    }
    async getMessages(ctx, req) {
        void ctx;
        const url = new URL(`session/${encodeSegment(req.id)}/message`, LOCAL_API_BASE);
        appendSearchParam(url, 'limit', req.limit);
        appendSearchParam(url, 'before', req.before);
        const body = await this.localApiJson(url);
        const messages = asArray(body.messages).map(mapSessionMessageView);
        return {
            messages,
            nextCursor: body.nextCursor ?? body.next_cursor,
            lastMsgId: body.lastMsgId ??
                body.last_msg_id ??
                (messages.length > 0 ? messages[messages.length - 1]?.msgId : undefined),
            hasMore: body.hasMore ?? body.has_more,
            todosJson: body.todosJson ?? body.todos_json,
        };
    }
    async sendMessage(ctx, req) {
        return openLocalSessionStream(this.localApiResponse, `session/${encodeSegment(req.id)}/message`, {
            method: 'POST',
            body: toSendMessageBody(req),
            signal: ctx.signal,
        });
    }
    async resumeSession(ctx, req) {
        try {
            const result = await openLocalSessionStream(this.localApiResponse, `session/${encodeSegment(req.id)}/resume`, {
                method: 'POST',
                body: {
                    afterMsgId: req.afterMsgId,
                    after_msg_id: req.afterMsgId,
                    after_message_id: req.afterMsgId,
                    afterCursor: req.afterCursor,
                    after_cursor: req.afterCursor,
                    drainQueued: req.drainQueued,
                    drain_queued: req.drainQueued,
                    continuePausedQueue: req.continuePausedQueue,
                    continue_paused_queue: req.continuePausedQueue,
                },
                signal: ctx.signal,
            });
            this.countSessionLifecycle('resume', result.ok ? 'ok' : 'error');
            return result;
        }
        catch (err) {
            this.countSessionLifecycle('resume', 'error');
            throw err;
        }
    }
    async abortSession(ctx, req) {
        void ctx;
        const abortSource = normalizeAbortSource(req.reason);
        return this.withSessionLifecycle('abort', () => this.localApiJson(`session/${encodeSegment(req.id)}/abort`, {
            method: 'POST',
            body: {
                ...(abortSource === 'unknown'
                    ? req.reason
                        ? { reason: req.reason }
                        : {}
                    : { abortSource }),
                turnId: req.turnId,
                turn_id: req.turnId,
            },
        }));
    }
    async listQueueMessages(ctx, req) {
        void ctx;
        return listLocalQueueMessages(this.localApiJson, req);
    }
    async getQueueItem(ctx, req) {
        void ctx;
        return getLocalQueueItem(this.localApiJson, req);
    }
    async enqueueMessage(ctx, req) {
        void ctx;
        return enqueueLocalMessage(this.localApiJson, req);
    }
    async updateQueueItem(ctx, req) {
        void ctx;
        return updateLocalQueueItem(this.localApiJson, req);
    }
    async reorderQueue(ctx, req) {
        void ctx;
        return reorderLocalQueue(this.localApiJson, req);
    }
    async deleteQueueItem(ctx, req) {
        void ctx;
        return deleteLocalQueueItem(this.localApiJson, req);
    }
    async getTurnDiff(ctx, req) {
        void ctx;
        const url = new URL(`session/${encodeSegment(req.id)}/turn-diff`, LOCAL_API_BASE);
        appendSearchParam(url, 'assistantMessageId', req.assistantMessageId);
        const body = await this.localApiJson(url);
        return mapTurnDiffFields(body);
    }
    async requestCompaction(ctx, req) {
        void ctx;
        return this.countBuiltinCommand('compact', () => requestLocalSessionCompaction(this.localApiJson, req));
    }
    async requestRotation(ctx, req) {
        void ctx;
        void req;
        throw new HTTPException(501, {
            res: jsonError(501, 'DesktopService.requestRotation is not implemented by local-runtime.', 'NOT_IMPLEMENTED'),
        });
    }
    async revertTurnDiff(ctx, req) {
        void ctx;
        const body = await this.localApiJson(`session/${encodeSegment(req.id)}/turn-diff/revert`, {
            method: 'POST',
            body: {
                changeSetId: req.changeSetId,
                assistantMessageId: req.assistantMessageId,
            },
        });
        const obj = asObject(body);
        return {
            success: obj.success === true,
            error: typeof obj.error === 'string' ? obj.error : undefined,
            turnDiff: mapTurnDiffView(obj),
        };
    }
    async reapplyTurnDiff(ctx, req) {
        void ctx;
        const body = await this.localApiJson(`session/${encodeSegment(req.id)}/turn-diff/reapply`, {
            method: 'POST',
            body: {
                changeSetId: req.changeSetId,
                assistantMessageId: req.assistantMessageId,
                turnId: req.turnId,
            },
        });
        const obj = asObject(body);
        return {
            success: obj.success === true,
            error: typeof obj.error === 'string' ? obj.error : undefined,
            ...mapTurnDiffFields(body),
        };
    }
}
//# sourceMappingURL=desktop-session-service.js.map