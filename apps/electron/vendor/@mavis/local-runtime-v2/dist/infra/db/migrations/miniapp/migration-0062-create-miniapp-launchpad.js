/** Mini App creation records share the Runtime database. */
export const migration = {
    version: 62,
    name: 'create_miniapp_creations',
    up: `
    CREATE TABLE local_runtime_miniapp_creations (
      account_id TEXT NOT NULL,
      deployment TEXT NOT NULL,
      id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      source_session_id TEXT,
      recommendation_id TEXT,
      requirements TEXT NOT NULL,
      source_summary TEXT,
      source_title TEXT,
      source_captured_at_ms INTEGER,
      workspace_dir TEXT,
      error TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (account_id, deployment, id),
      CONSTRAINT miniapp_creation_status CHECK (status IN ('building', 'waiting', 'ready', 'failed', 'interrupted')),
      CONSTRAINT miniapp_creation_created_at CHECK (created_at_ms >= 0)
    );
    CREATE INDEX idx_miniapp_creations_status
      ON local_runtime_miniapp_creations(account_id, deployment, status, created_at_ms DESC, id DESC);
    CREATE INDEX idx_miniapp_creations_plugin
      ON local_runtime_miniapp_creations(account_id, deployment, plugin_id);
    CREATE INDEX idx_miniapp_creations_source_session
      ON local_runtime_miniapp_creations(account_id, deployment, source_session_id);
    CREATE INDEX idx_miniapp_creations_session
      ON local_runtime_miniapp_creations(account_id, deployment, session_id);
  `,
};
//# sourceMappingURL=migration-0062-create-miniapp-launchpad.js.map