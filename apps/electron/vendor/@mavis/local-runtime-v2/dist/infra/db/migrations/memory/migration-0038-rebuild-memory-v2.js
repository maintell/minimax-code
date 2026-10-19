export const migration = {
    version: 38,
    name: 'rebuild_memory_v2',
    up(database) {
        const legacyTables = database
            .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'local_runtime_v2_memory_items',
        'local_runtime_v2_memory_session_captures',
        'local_runtime_v2_memory_forget_markers'
      )
    `)
            .all();
        for (const table of legacyTables) {
            const rows = database.prepare(`SELECT 1 FROM ${table.name} LIMIT 1`).all();
            if (rows.length > 0) {
                throw new Error('Memory V2 legacy data requires explicit Reset before storage rebuild');
            }
        }
        database.exec(`
    DROP TABLE IF EXISTS local_runtime_v2_memory_forget_markers;
    DROP TABLE IF EXISTS local_runtime_v2_memory_items;
    DROP TABLE IF EXISTS local_runtime_v2_memory_session_captures;
    DROP TABLE IF EXISTS local_runtime_v2_memory_spaces;
    DROP TABLE IF EXISTS local_runtime_v2_memory_session_states;
    DROP TABLE IF EXISTS local_runtime_v2_memory_scopes;

    CREATE TABLE local_runtime_v2_memory_scopes (
      scope_key               TEXT PRIMARY KEY,
      reset_epoch             INTEGER NOT NULL DEFAULT 0 CONSTRAINT local_runtime_v2_memory_scopes_reset_epoch_check CHECK (reset_epoch >= 0),
      reset_at_ms             INTEGER NOT NULL DEFAULT 0 CONSTRAINT local_runtime_v2_memory_scopes_reset_at_ms_check CHECK (reset_at_ms >= 0),
      consolidated_digest     TEXT,
      last_consolidated_at_ms INTEGER,
      created_at_ms           INTEGER NOT NULL,
      updated_at_ms           INTEGER NOT NULL
    );

    CREATE TABLE local_runtime_v2_memory_session_states (
      scope_key             TEXT NOT NULL REFERENCES local_runtime_v2_memory_scopes(scope_key) ON DELETE CASCADE,
      session_id            TEXT NOT NULL,
      session_created_at_ms INTEGER NOT NULL,
      source_revision       TEXT NOT NULL,
      source_digest         TEXT NOT NULL,
      capture_contract_id   TEXT NOT NULL,
      output_digest         TEXT NOT NULL,
      content               TEXT,
      forget_rules          TEXT,
      agent_name            TEXT,
      project_name          TEXT,
      workspace_dir         TEXT,
      captured_at_ms        INTEGER NOT NULL,
      last_used_at_ms       INTEGER CONSTRAINT local_runtime_v2_memory_session_states_last_used_check CHECK (last_used_at_ms IS NULL OR last_used_at_ms >= 0),
      exclusion_reason      TEXT,
      created_at_ms         INTEGER NOT NULL,
      updated_at_ms         INTEGER NOT NULL,
      PRIMARY KEY (scope_key, session_id)
    );

    CREATE INDEX idx_local_runtime_v2_memory_session_states_selection
      ON local_runtime_v2_memory_session_states (
        scope_key,
        exclusion_reason,
        last_used_at_ms DESC,
        captured_at_ms DESC,
        session_id ASC
      );

    CREATE TABLE local_runtime_v2_memory_capture_attempts (
      scope_key       TEXT NOT NULL REFERENCES local_runtime_v2_memory_scopes(scope_key) ON DELETE CASCADE,
      session_id      TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      attempts        INTEGER NOT NULL CONSTRAINT local_runtime_v2_memory_capture_attempts_attempts_check CHECK (attempts >= 1),
      last_reason     TEXT,
      retry_at_ms     INTEGER NOT NULL,
      updated_at_ms   INTEGER NOT NULL,
      PRIMARY KEY (scope_key, session_id)
    );

    CREATE TABLE local_runtime_v2_memory_baseline_files (
      scope_key     TEXT NOT NULL REFERENCES local_runtime_v2_memory_scopes(scope_key) ON DELETE CASCADE,
      file_name     TEXT NOT NULL,
      content       TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (scope_key, file_name)
    );
    `);
    },
};
//# sourceMappingURL=migration-0038-rebuild-memory-v2.js.map