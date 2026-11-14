/**
 * Full-text index over Bunny's current main conversation. One document per searchable
 * part of a display message (its visible text, a task report or card conclusion, one
 * attachment); the FTS row shares the document's id. Additive DDL only.
 */
export const migration = {
    version: 55,
    name: 'create_message_search_index',
    up: `
    CREATE TABLE IF NOT EXISTS local_runtime_message_search_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      part TEXT NOT NULL,
      message_row_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      task_id TEXT,
      space_id TEXT,
      asset_id TEXT,
      body TEXT NOT NULL,
      word_offsets TEXT NOT NULL,
      tokenizer_version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      indexed_at_ms INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_message_search_docs_message_part
      ON local_runtime_message_search_docs(session_id, message_id, part);
    CREATE INDEX IF NOT EXISTS idx_message_search_docs_session_row
      ON local_runtime_message_search_docs(session_id, message_row_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS local_runtime_message_search_fts USING fts5(
      words,
      chars,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS local_runtime_message_search_state (
      session_id TEXT PRIMARY KEY NOT NULL,
      tokenizer_version TEXT NOT NULL,
      backfilled_through_row_id INTEGER NOT NULL,
      completed_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    );
  `,
};
//# sourceMappingURL=migration-0055-create-message-search-index.js.map