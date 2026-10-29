export const QUESTIONNAIRE_MIGRATIONS = [
    {
        version: 21,
        sql: `
      CREATE TABLE IF NOT EXISTS questionnaire_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_name TEXT,
        msg_id TEXT,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        answered_at INTEGER,
        reply_payload TEXT,
        injected_at INTEGER,
        dismissed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_questionnaire_requests_session_status_created
        ON questionnaire_requests(session_id, status, created_at, request_id);
      CREATE INDEX IF NOT EXISTS idx_questionnaire_requests_answered_injected
        ON questionnaire_requests(status, answered_at, injected_at);
    `,
    },
    {
        version: 22,
        sql: `
      ALTER TABLE questionnaire_requests ADD COLUMN origin_channel_context_json TEXT;
    `,
    },
    {
        // AskUser v2: 'sync' | 'async', written once when a Desktop ask_user call
        // creates the row and never updated. NULL is the legacy lifecycle (rows
        // created before this migration, IM/CLI/TUI Turns, Plan cards and
        // feature-enable cards), so old rows need no backfill.
        //
        // Version choice: this array is recorded in the v1 ledger
        // `local_runtime_schema_migrations`, which is independent of the v2
        // ledger `local_runtime_v2_schema_migrations`, so v2 migration numbers do
        // not collide with it. v1 last used 34 (Workspace Indexing); 35 is skipped
        // because the retired AskUser deferred-continuation branch registered 35
        // on developer databases with different DDL, and reusing it would leave
        // this column missing there.
        version: 36,
        sql: `
      ALTER TABLE questionnaire_requests ADD COLUMN response_mode TEXT;
    `,
    },
];
//# sourceMappingURL=schema.js.map