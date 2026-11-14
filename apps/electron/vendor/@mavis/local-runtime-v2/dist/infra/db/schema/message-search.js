import { getTableConfig, index, integer, sqliteTable, text, uniqueIndex, } from 'drizzle-orm/sqlite-core';
/**
 * One searchable part of a display message in Bunny's current main conversation: its
 * visible text, a task report or card conclusion, or one attachment. The FTS row in
 * {@link messageSearchFts} uses the same id as its rowid.
 */
export const messageSearchDocs = sqliteTable('local_runtime_message_search_docs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    messageId: text('message_id').notNull(),
    /** `text`, `task:<task id>` or `asset:<asset id>`. */
    part: text('part').notNull(),
    /** Display row id; orders documents the way the conversation is shown. */
    messageRowId: integer('message_row_id').notNull(),
    role: text('role').notNull(),
    createdAtMs: integer('created_at_ms').notNull(),
    taskId: text('task_id'),
    spaceId: text('space_id'),
    assetId: text('asset_id'),
    /** The visible text the snippet and read results are cut from. */
    body: text('body').notNull(),
    /** JSON `[start, end, ...]` UTF-16 offsets of each word-column token in `body`. */
    wordOffsets: text('word_offsets').notNull(),
    tokenizerVersion: text('tokenizer_version').notNull(),
    contentHash: text('content_hash').notNull(),
    indexedAtMs: integer('indexed_at_ms').notNull(),
}, (table) => [
    uniqueIndex('idx_message_search_docs_message_part').on(table.sessionId, table.messageId, table.part),
    index('idx_message_search_docs_session_row').on(table.sessionId, table.messageRowId),
]);
/** Background backfill progress of one Session under one tokenizer version. */
export const messageSearchState = sqliteTable('local_runtime_message_search_state', {
    sessionId: text('session_id').primaryKey().notNull(),
    tokenizerVersion: text('tokenizer_version').notNull(),
    backfilledThroughRowId: integer('backfilled_through_row_id').notNull(),
    completedAtMs: integer('completed_at_ms'),
    updatedAtMs: integer('updated_at_ms').notNull(),
});
/**
 * The FTS5 table (DDL in m0055): `words` holds word-level tokens, `chars` single CJK
 * characters and whole other runs, both pre-tokenized and joined by spaces. Declared
 * here only so queries are built with Drizzle; its rowid is the document id.
 */
export const messageSearchFts = sqliteTable('local_runtime_message_search_fts', {
    rowid: integer('rowid').primaryKey(),
    words: text('words').notNull(),
    chars: text('chars').notNull(),
});
export const MESSAGE_SEARCH_TABLE_METADATA = [messageSearchDocs, messageSearchState].map((table) => {
    const config = getTableConfig(table);
    return { name: config.name, columns: config.columns.map((column) => column.name) };
});
//# sourceMappingURL=message-search.js.map