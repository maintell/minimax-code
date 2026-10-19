export const migration = {
    version: 41,
    name: 'create_session_clio',
    up: (database) => {
        database.exec(`
      CREATE TABLE local_runtime_session_clio_state (
        identity_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        trajectory_id TEXT NOT NULL,
        capture_origin INTEGER NOT NULL,
        biz_id TEXT NOT NULL,
        input_version INTEGER NOT NULL,
        eligibility TEXT NOT NULL,
        state_json TEXT NOT NULL,
        deadline_ms INTEGER NOT NULL,
        sealed_at_ms INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (identity_key, session_id),
        CONSTRAINT local_runtime_session_clio_state_eligibility_check
          CHECK (eligibility IN ('enrolled', 'excluded'))
      );
      CREATE INDEX idx_local_runtime_session_clio_state_due
        ON local_runtime_session_clio_state (sealed_at_ms, deadline_ms);

      CREATE TABLE local_runtime_session_clio_outbox (
        identity_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        trajectory_id TEXT NOT NULL,
        capture_origin INTEGER NOT NULL,
        biz_id TEXT NOT NULL,
        input_version INTEGER NOT NULL,
        step_type INTEGER NOT NULL,
        client_produced_ts INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (identity_key, session_id, seq),
        CONSTRAINT local_runtime_session_clio_outbox_step_type_check
          CHECK (step_type IN (6, 7, 8))
      );
      CREATE INDEX idx_local_runtime_session_clio_outbox_ready
        ON local_runtime_session_clio_outbox (identity_key, next_attempt_at_ms, session_id, seq);
    `);
    },
};
//# sourceMappingURL=migration-0041-create-session-clio.js.map