import { createHash } from 'node:crypto';
import { BUNNY_AGENT_NAME } from '@mavis/shared/agent-avatar';
import { and, asc, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { messageRows } from '../../../../infra/db/schema/messages.js';
import { messageSearchDocs, messageSearchFts, messageSearchState, } from '../../../../infra/db/schema/message-search.js';
import { sessions } from '../../../../infra/db/schema/sessions.js';
import { decodeDisplayMessage } from '../repo/codec.js';
import { MessageDataCorruptionError } from '../repo/contract.js';
import { extractSearchDocuments } from './documents.js';
import { NO_MEDIA_DESCRIPTIONS, } from './options.js';
import { defaultSearchTokenizer } from './tokenizer.js';
const DELETE_CHUNK = 500;
/** Only Bunny's current main conversation is indexed; forks and archived roots are not (15.1). */
export function isSearchIndexedSession(db, sessionId) {
    return (db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(and(eq(sessions.sessionId, sessionId), mainSessionPredicate()))
        .get() !== undefined);
}
export function currentMainSessionId(db) {
    return db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(mainSessionPredicate())
        .orderBy(desc(sessions.updatedAtMs))
        .limit(1)
        .get()?.sessionId;
}
/**
 * Session kinds that never turn into a conversation. A cron run can be detached into a
 * conversation and legacy `unknown` rows may be one, so those two stay checked.
 */
const NEVER_CONVERSATION_KINDS = new Set(['task', 'peek', 'channel']);
/**
 * The index as an observer of message writes, kept in the write's transaction. It sees
 * Bunny's Sessions of a kind that can become a conversation; those fields never change
 * after creation (Bunny is a reserved built-in agent name), so any other Session never
 * has index rows. The conditions that do change (root, not archived) are checked
 * inside the transaction.
 */
export function createMessageSearchIndexObserver(options = {}) {
    return {
        observes: (session) => session.agentName === BUNNY_AGENT_NAME && !NEVER_CONVERSATION_KINDS.has(session.sessionKind),
        written: (tx, write) => syncMessageSearchIndex(tx, write.sessionId, write.messageId, options),
        deleted: (tx, deletion) => deleteMessageSearchDocuments(tx, deletion.sessionId, deletion.messageIds, {
            forgetProgress: deletion.sessionDataDeleted === true,
        }),
    };
}
function mainSessionPredicate() {
    return and(eq(sessions.agentName, BUNNY_AGENT_NAME), eq(sessions.runtime, 'pi-agent'), eq(sessions.sessionType, 'root'), eq(sessions.sessionKind, 'conversation'), eq(sessions.archived, 0));
}
/**
 * Rebuilds the documents of one message row inside the caller's write transaction.
 * Unchanged content is skipped, so a streaming rewrite only pays when the text changed.
 * An index failure never fails the message write: it rolls back to its own savepoint
 * and marks the Session for a background rebuild.
 */
export function syncMessageSearchIndex(db, sessionId, messageId, options = {}) {
    guarded(db, sessionId, (tx) => {
        if (!isSearchIndexedSession(tx, sessionId))
            return;
        const row = tx
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), eq(messageRows.messageId, messageId)))
            .get();
        if (row)
            indexMessageRow(tx, row, options);
    });
}
/**
 * Deletes, in the caller's transaction, the documents of the given messages or, without
 * ids, of the whole Session. Deleting a Session's data also forgets its backfill progress.
 * Any Session that may have been indexed is cleaned, archived former main conversations
 * included.
 */
function deleteMessageSearchDocuments(db, sessionId, messageIds, options = {}) {
    if (messageIds?.length === 0)
        return;
    guarded(db, sessionId, (tx) => {
        if (!messageIds) {
            deleteDocuments(tx, documentIds(tx, eq(messageSearchDocs.sessionId, sessionId)));
            if (options.forgetProgress)
                tx.delete(messageSearchState).where(eq(messageSearchState.sessionId, sessionId)).run();
            return;
        }
        for (let index = 0; index < messageIds.length; index += DELETE_CHUNK) {
            const chunk = messageIds.slice(index, index + DELETE_CHUNK);
            deleteDocuments(tx, documentIds(tx, and(eq(messageSearchDocs.sessionId, sessionId), inArray(messageSearchDocs.messageId, chunk))));
        }
    });
}
/** Bunny initialization empties the whole index (spec 2.3). */
export function clearMessageSearchIndex(db) {
    db.delete(messageSearchFts).run();
    db.delete(messageSearchDocs).run();
    db.delete(messageSearchState).run();
}
/**
 * One backfill step of a Session in its own short transaction: indexes the next rows
 * from their current content, so a deleted message is never revived and a newer
 * document is never overwritten. A tokenizer version change restarts from the first row.
 */
export function backfillMessageSearchBatch(db, sessionId, options = {}) {
    const tokenizer = options.tokenizer ?? defaultSearchTokenizer();
    const batchSize = options.batchSize ?? 100;
    const nowMs = options.nowMs ?? Date.now;
    return db.transaction((tx) => {
        if (!isSearchIndexedSession(tx, sessionId))
            return { done: true, indexed: 0 };
        const state = tx
            .select()
            .from(messageSearchState)
            .where(eq(messageSearchState.sessionId, sessionId))
            .get();
        const current = state?.tokenizerVersion === tokenizer.version;
        if (current && state.completedAtMs !== null)
            return { done: true, indexed: 0 };
        const cursor = current ? state.backfilledThroughRowId : 0;
        const rows = tx
            .select()
            .from(messageRows)
            .where(and(eq(messageRows.sessionId, sessionId), gt(messageRows.id, cursor)))
            .orderBy(asc(messageRows.id))
            .limit(batchSize)
            .all();
        rows.forEach((row) => indexMessageRow(tx, row, { ...options, tokenizer }));
        const done = rows.length < batchSize;
        if (done)
            deleteOrphanDocuments(tx, sessionId);
        const next = {
            sessionId,
            tokenizerVersion: tokenizer.version,
            backfilledThroughRowId: rows.at(-1)?.id ?? cursor,
            completedAtMs: done ? nowMs() : null,
            updatedAtMs: nowMs(),
        };
        tx.insert(messageSearchState)
            .values(next)
            .onConflictDoUpdate({ target: messageSearchState.sessionId, set: next })
            .run();
        return { done, indexed: rows.length };
    }, { behavior: 'immediate' });
}
/** Removes up to `limit` documents of Sessions that are no longer the main conversation. */
export function purgeMessageSearchOutside(db, keepSessionId, limit = DELETE_CHUNK) {
    return db.transaction((tx) => {
        const scope = keepSessionId ? ne(messageSearchDocs.sessionId, keepSessionId) : undefined;
        const ids = tx
            .select({ id: messageSearchDocs.id })
            .from(messageSearchDocs)
            .where(scope)
            .limit(limit)
            .all()
            .map(({ id }) => id);
        deleteDocuments(tx, ids);
        tx.delete(messageSearchState)
            .where(keepSessionId ? ne(messageSearchState.sessionId, keepSessionId) : undefined)
            .run();
        return ids.length;
    }, { behavior: 'immediate' });
}
function indexMessageRow(db, row, options) {
    const tokenizer = options.tokenizer ?? defaultSearchTokenizer();
    const documents = readDrafts(row).map((draft) => resolveDocument(db, row, draft, {
        descriptions: options.descriptions ?? NO_MEDIA_DESCRIPTIONS,
        ...(options.spaces ? { spaces: options.spaces } : {}),
    }));
    const contentHash = createHash('sha256')
        .update(JSON.stringify([tokenizer.version, row.id, row.createdAtMs, documents]))
        .digest('base64url');
    const existing = db
        .select({ id: messageSearchDocs.id, contentHash: messageSearchDocs.contentHash })
        .from(messageSearchDocs)
        .where(and(eq(messageSearchDocs.sessionId, row.sessionId), eq(messageSearchDocs.messageId, row.messageId)))
        .all();
    if (existing.length === documents.length &&
        existing.every((document) => document.contentHash === contentHash))
        return;
    deleteDocuments(db, existing.map(({ id }) => id));
    const indexedAtMs = (options.nowMs ?? Date.now)();
    for (const document of documents) {
        const words = tokenizer.words(document.body);
        const inserted = db
            .insert(messageSearchDocs)
            .values({
            sessionId: row.sessionId,
            messageId: row.messageId,
            part: document.part,
            messageRowId: row.id,
            role: document.role,
            createdAtMs: row.createdAtMs,
            taskId: document.taskId ?? null,
            spaceId: document.spaceId ?? null,
            assetId: document.assetId ?? null,
            body: document.body,
            wordOffsets: JSON.stringify(words.flatMap((token) => [token.start, token.end])),
            tokenizerVersion: tokenizer.version,
            contentHash,
            indexedAtMs,
        })
            .returning({ id: messageSearchDocs.id })
            .get();
        db.insert(messageSearchFts)
            .values({
            rowid: inserted.id,
            words: joinTokens(words),
            chars: joinTokens(tokenizer.chars(document.body)),
        })
            .run();
    }
}
function readDrafts(row) {
    try {
        return extractSearchDocuments(decodeDisplayMessage(row));
    }
    catch (error) {
        // A corrupt row has nothing a person can read back; it is simply not searchable.
        if (error instanceof MessageDataCorruptionError)
            return [];
        throw error;
    }
}
function resolveDocument(db, row, draft, sources) {
    const spaceId = draft.spaceId ?? (draft.taskId ? sources.spaces?.sessionSpace(draft.taskId) : undefined);
    const description = draft.assetId
        ? sources.descriptions
            .describe({
            sessionId: row.sessionId,
            messageId: row.messageId,
            assetId: draft.assetId,
        })
            ?.trim()
        : undefined;
    return {
        ...draft,
        ...(spaceId ? { spaceId } : {}),
        ...(description ? { body: `${draft.body}\n${description}` } : {}),
    };
}
function joinTokens(tokens) {
    return tokens.map((token) => token.text).join(' ');
}
function documentIds(db, where) {
    return db
        .select({ id: messageSearchDocs.id })
        .from(messageSearchDocs)
        .where(where)
        .all()
        .map(({ id }) => id);
}
function deleteDocuments(db, ids) {
    for (let index = 0; index < ids.length; index += DELETE_CHUNK) {
        const chunk = ids.slice(index, index + DELETE_CHUNK);
        db.delete(messageSearchFts).where(inArray(messageSearchFts.rowid, chunk)).run();
        db.delete(messageSearchDocs).where(inArray(messageSearchDocs.id, chunk)).run();
    }
}
/** Documents whose message row is gone; only possible after a failed delete. */
function deleteOrphanDocuments(db, sessionId) {
    const ids = db
        .select({ id: messageSearchDocs.id })
        .from(messageSearchDocs)
        .where(and(eq(messageSearchDocs.sessionId, sessionId), sql `NOT EXISTS (SELECT 1 FROM ${messageRows} m
          WHERE m.session_id = ${messageSearchDocs.sessionId}
            AND m.msg_id = ${messageSearchDocs.messageId})`))
        .all()
        .map(({ id }) => id);
    deleteDocuments(db, ids);
}
function guarded(db, sessionId, run) {
    try {
        db.transaction((tx) => run(tx));
    }
    catch {
        markSessionStale(db, sessionId);
    }
}
/** A Session whose index may be out of date is rebuilt by the next backfill. */
function markSessionStale(db, sessionId) {
    try {
        db.delete(messageSearchState).where(eq(messageSearchState.sessionId, sessionId)).run();
    }
    catch {
        // Without the index tables there is nothing to mark.
    }
}
//# sourceMappingURL=index-store.js.map