import { writeHistoryCheckpointInTransaction } from '../legacy-migration/repo/history-checkpoint.js';
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm';
import { sessions, sessionSideChats } from '../../../infra/db/schema/sessions.js';
import { QueueClaimNotFoundError } from '../queue/repo/contract.js';
import { decodeSessionRow, encodeSessionRow } from './repo/drizzle/codec.js';
import { writeSessionSearchDocument } from './repo/search.js';
import { normalizePageLimit } from './repo/pagination.js';
import { CURRENT_SESSION_DATA_VERSION } from './support/version.js';
export class SideChatError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'SideChatError';
    }
}
/** Commits Side context, relation and an optional first execution input atomically. */
export function createSideChatDataCapability(options) {
    function requireMain(db, sessionId) {
        const row = db.select().from(sessions).where(eq(sessions.sessionId, sessionId)).get();
        if (!row)
            throw new Error(`Session not found: ${sessionId}`);
        if (options.deletion.rejectionInTransaction(db, { sessionId }) === 'session-deleting') {
            throw new SideChatError('SESSION_DELETING', 'Session is being deleted');
        }
        return row;
    }
    return {
        async prepareModel(mainSessionId, model) {
            const source = decodeSessionRow(requireMain(options.db, mainSessionId));
            return options.resolveModel ? options.resolveModel(source, model) : model;
        },
        activeSessionIds(mainSessionId) {
            return options.db
                .select({ id: sessionSideChats.sideSessionId })
                .from(sessionSideChats)
                .where(eq(sessionSideChats.mainSessionId, mainSessionId))
                .all()
                .map(({ id }) => id);
        },
        relation(sessionId) {
            return options.db
                .select()
                .from(sessionSideChats)
                .where(eq(sessionSideChats.sideSessionId, sessionId))
                .get();
        },
        list(mainSessionId, page = {}) {
            const limit = normalizePageLimit(page.limit);
            const cursorRow = decodeCursor(page.cursor, mainSessionId);
            const rows = options.db
                .select({ session: sessions })
                .from(sessionSideChats)
                .innerJoin(sessions, eq(sessions.sessionId, sessionSideChats.sideSessionId))
                .where(and(eq(sessionSideChats.mainSessionId, mainSessionId), cursorRow
                ? or(lt(sessionSideChats.createdAtMs, cursorRow.createdAtMs), and(eq(sessionSideChats.createdAtMs, cursorRow.createdAtMs), gt(sessionSideChats.sideSessionId, cursorRow.sideSessionId)))
                : undefined))
                .orderBy(desc(sessionSideChats.createdAtMs), asc(sessionSideChats.sideSessionId))
                .limit(limit + 1)
                .all();
            const selected = rows.slice(0, limit).map(({ session }) => decodeSessionRow(session));
            const hasMore = rows.length > limit;
            return {
                sessions: selected,
                hasMore,
                ...(hasMore
                    ? {
                        nextCursor: Buffer.from(JSON.stringify({
                            mainSessionId,
                            createdAtMs: selected.at(-1).createdAtMs,
                            sideSessionId: selected.at(-1).sessionId,
                        })).toString('base64url'),
                    }
                    : {}),
            };
        },
        promote(sessionId, nowMs) {
            return options.db.transaction((db) => {
                const row = requireMain(db, sessionId);
                const session = decodeSessionRow(row);
                const relation = db
                    .select()
                    .from(sessionSideChats)
                    .where(eq(sessionSideChats.sideSessionId, sessionId))
                    .get();
                if (!relation) {
                    if (!session.sideChatOrigin)
                        throw new Error('Session is not a SideChat');
                    return { session };
                }
                requireMain(db, relation.mainSessionId);
                const promoted = { ...session, visibility: 'visible', updatedAtMs: nowMs };
                db.delete(sessionSideChats).where(eq(sessionSideChats.sideSessionId, sessionId)).run();
                db.update(sessions)
                    .set(encodeSessionRow(promoted, {
                    projectId: row.projectId,
                    preservedRecordJson: row.recordJson,
                }))
                    .where(eq(sessions.sessionId, sessionId))
                    .run();
                writeSessionSearchDocument(db, promoted);
                return { session: promoted, previousMainSessionId: relation.mainSessionId };
            }, { behavior: 'immediate' });
        },
        commit(input) {
            const model = input.model ?? input.input?.model;
            return options.db.transaction((db) => {
                const sourceRow = requireMain(db, input.mainSessionId);
                const source = decodeSessionRow(sourceRow);
                let consumed;
                if (input.sourceClaim) {
                    if (input.sourceClaim.sessionId !== input.mainSessionId)
                        throw new SideChatError('QUEUE_ITEM_NOT_TRANSFERABLE', 'Queue item does not belong to Main');
                    try {
                        consumed = options.queue.consumeTransferClaimInTransaction(db, input.sourceClaim);
                    }
                    catch (error) {
                        if (error instanceof QueueClaimNotFoundError)
                            throw new SideChatError('QUEUE_ITEM_NOT_TRANSFERABLE', 'Queue item is no longer transferable');
                        throw error;
                    }
                }
                const session = {
                    sessionId: input.sessionId,
                    agentName: source.agentName,
                    workspaceDir: source.workspaceDir,
                    runtime: source.runtime,
                    sessionType: 'branch',
                    sessionKind: 'conversation',
                    title: input.title,
                    titleSource: 'default',
                    parentSessionId: null,
                    visibility: 'hidden',
                    archived: false,
                    status: 'idle',
                    isDefaultWorkspace: source.isDefaultWorkspace,
                    runLocation: source.runLocation,
                    appMode: source.appMode,
                    ...initialModelSnapshot(source, model),
                    sessionOrigin: 'local-runtime',
                    sessionDataVersion: CURRENT_SESSION_DATA_VERSION,
                    origin: 'user',
                    historyRelativeDir: input.historyRelativeDir,
                    createdAtMs: input.createdAtMs,
                    updatedAtMs: input.createdAtMs,
                    sideChatOrigin: {
                        mainSessionId: input.mainSessionId,
                        capturedAtMs: input.createdAtMs,
                        historyRevision: input.historyRevision,
                        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
                        ...(input.display.at(-1)?.msg_id
                            ? { inheritedThroughMessageId: input.display.at(-1).msg_id }
                            : {}),
                    },
                };
                db.insert(sessions)
                    .values(encodeSessionRow(session, { projectId: sourceRow.projectId }))
                    .run();
                writeSessionSearchDocument(db, session);
                writeHistoryCheckpointInTransaction(db, {
                    sessionId: session.sessionId,
                    migratedAtMs: input.createdAtMs,
                    source: 'empty',
                    messageCount: input.messageCount,
                    targetRevision: input.targetRevision,
                });
                db.insert(sessionSideChats)
                    .values({
                    sideSessionId: session.sessionId,
                    mainSessionId: input.mainSessionId,
                    createdAtMs: input.createdAtMs,
                })
                    .run();
                options.messages.upsertManyInTransaction(db, input.display.map((message) => ({ sessionId: session.sessionId, message })));
                const queued = input.input
                    ? options.queue.enqueueInTransaction(db, { ...input.input, session })
                    : undefined;
                if (queued && !queued.value)
                    throw new SideChatError('SIDECHAT_PREPARATION_FAILED', 'First input was not admitted');
                return { session, queued, consumed };
            }, { behavior: 'immediate' });
        },
    };
}
function initialModelSnapshot(source, model) {
    // 首发已解析的完整模型组与入队输入一致，不能混入父会话的 effort/context/output cap。
    if (model?.provider_id && model.model_id) {
        let variant = model.variant;
        if (model.reasoning !== undefined)
            variant = model.reasoning ? 'thinking' : '';
        return {
            effectiveModel: `${model.provider_id}/${model.model_id}`,
            effectiveModelVariant: variant,
            effectiveModelThinking: model.reasoning === false ? undefined : model.thinking,
            effectiveModelContextWindow: model.context_limit,
            effectiveModelMaxOutputTokens: model.max_output_tokens,
        };
    }
    // 没有显式模型组的队列转发维持既有父会话继承语义。
    return {
        effectiveModel: source.effectiveModel,
        effectiveModelVariant: source.effectiveModelVariant,
        effectiveModelThinking: source.effectiveModelThinking,
        effectiveModelContextWindow: source.effectiveModelContextWindow,
        effectiveModelMaxOutputTokens: source.effectiveModelMaxOutputTokens,
    };
}
function decodeCursor(value, mainSessionId) {
    if (!value)
        return undefined;
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
        return parsed?.mainSessionId === mainSessionId &&
            Number.isSafeInteger(parsed.createdAtMs) &&
            typeof parsed.sideSessionId === 'string'
            ? { createdAtMs: parsed.createdAtMs, sideSessionId: parsed.sideSessionId }
            : undefined;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=sidechat-data-capability.js.map