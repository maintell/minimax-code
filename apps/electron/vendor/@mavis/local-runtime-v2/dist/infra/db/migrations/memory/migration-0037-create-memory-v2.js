export const migration = {
    version: 37,
    name: 'create_memory_v2',
    up: `
    CREATE TABLE local_runtime_v2_memory_spaces (
      scope_key                TEXT PRIMARY KEY,
      agent_name               TEXT NOT NULL,
      project_identity         TEXT NOT NULL,
      epoch_started_at_ms      INTEGER NOT NULL,
      recall_epoch             INTEGER NOT NULL DEFAULT 0
        CONSTRAINT local_runtime_v2_memory_spaces_recall_epoch_check
        CHECK (recall_epoch >= 0),
      current_generation_id    TEXT,
      current_view_input_digest TEXT,
      CONSTRAINT local_runtime_v2_memory_spaces_generation_check CHECK (
        (current_generation_id IS NULL AND current_view_input_digest IS NULL)
        OR
        (current_generation_id IS NOT NULL AND current_view_input_digest IS NOT NULL)
      ),
      UNIQUE (agent_name, project_identity)
    );

    CREATE TABLE local_runtime_v2_memory_session_captures (
      session_id           TEXT PRIMARY KEY
        REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      scope_key            TEXT NOT NULL
        REFERENCES local_runtime_v2_memory_spaces(scope_key) ON DELETE CASCADE,
      capture_input_digest TEXT,
      captured_at_ms       INTEGER,
      last_used_at_ms      INTEGER,
      exclusion_reason     TEXT
        CONSTRAINT local_runtime_v2_memory_session_captures_exclusion_check
        CHECK (exclusion_reason IS NULL OR exclusion_reason IN ('external-context', 'session-delete')),
      CONSTRAINT local_runtime_v2_memory_session_captures_shape_check CHECK (
        exclusion_reason IS NOT NULL
        OR (capture_input_digest IS NOT NULL AND captured_at_ms IS NOT NULL)
      )
    );

    CREATE TABLE local_runtime_v2_memory_items (
      item_id                   TEXT PRIMARY KEY,
      session_id                TEXT NOT NULL
        REFERENCES local_runtime_v2_memory_session_captures(session_id) ON DELETE CASCADE,
      kind                      TEXT NOT NULL
        CONSTRAINT local_runtime_v2_memory_items_kind_check
        CHECK (kind IN ('preference', 'fact', 'decision', 'procedure', 'correction')),
      statement                 TEXT NOT NULL,
      evidence_message_ids_json TEXT NOT NULL
    );

    CREATE TABLE local_runtime_v2_memory_forget_markers (
      item_id           TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL
        REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE,
      forgotten_at_ms   INTEGER NOT NULL
    );

    CREATE INDEX idx_memory_captures_scope_rank
      ON local_runtime_v2_memory_session_captures(
        scope_key,
        last_used_at_ms DESC,
        captured_at_ms DESC,
        session_id
      );
    CREATE INDEX idx_memory_items_session
      ON local_runtime_v2_memory_items(session_id);
    CREATE INDEX idx_memory_forget_markers_session
      ON local_runtime_v2_memory_forget_markers(source_session_id);
  `,
};
//# sourceMappingURL=migration-0037-create-memory-v2.js.map