export const WORKSPACE_INDEXING_MIGRATIONS = [
    {
        // 26 is owned by session-assets/schema.ts.
        version: 27,
        sql: `
      CREATE TABLE IF NOT EXISTS local_runtime_workspace_indexing_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_real_path TEXT NOT NULL,
        status TEXT NOT NULL,
        initial_revision_id TEXT,
        latest_revision_id TEXT,
        latest_root_hash TEXT,
        skip_reason TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_runtime_workspace_sessions_workspace
        ON local_runtime_workspace_indexing_sessions(workspace_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS local_runtime_workspace_indexing_revisions (
        revision_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        root_hash TEXT NOT NULL,
        base_revision_id TEXT,
        base_root_hash TEXT,
        archive_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        archive_oss_key TEXT,
        manifest_oss_key TEXT,
        remote_state TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at_ms INTEGER NOT NULL,
        last_error_code TEXT,
        embedding_model TEXT,
        dimensions INTEGER,
        normalization TEXT,
        index_sha256 TEXT,
        index_size_bytes INTEGER,
        index_archive_path TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(session_id)
          REFERENCES local_runtime_workspace_indexing_sessions(session_id)
          ON DELETE CASCADE,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_local_runtime_workspace_revisions_session
        ON local_runtime_workspace_indexing_revisions(session_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_local_runtime_workspace_revisions_remote_work
        ON local_runtime_workspace_indexing_revisions(remote_state, next_retry_at_ms);
    `,
    },
    {
        // Goal compatibility already published a version-27 marker. Existing databases
        // can therefore skip the workspace-indexing migration above. Keep that migration
        // immutable and repair the collision with a new idempotent version.
        version: 28,
        sql: `
      CREATE TABLE IF NOT EXISTS local_runtime_workspace_indexing_sessions (
        session_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        workspace_real_path TEXT NOT NULL,
        status TEXT NOT NULL,
        initial_revision_id TEXT,
        latest_revision_id TEXT,
        latest_root_hash TEXT,
        skip_reason TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_local_runtime_workspace_sessions_workspace
        ON local_runtime_workspace_indexing_sessions(workspace_id, updated_at_ms DESC);

      CREATE TABLE IF NOT EXISTS local_runtime_workspace_indexing_revisions (
        revision_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        root_hash TEXT NOT NULL,
        base_revision_id TEXT,
        base_root_hash TEXT,
        archive_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        archive_sha256 TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        archive_oss_key TEXT,
        manifest_oss_key TEXT,
        remote_state TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at_ms INTEGER NOT NULL,
        last_error_code TEXT,
        embedding_model TEXT,
        dimensions INTEGER,
        normalization TEXT,
        index_sha256 TEXT,
        index_size_bytes INTEGER,
        index_archive_path TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY(session_id)
          REFERENCES local_runtime_workspace_indexing_sessions(session_id)
          ON DELETE CASCADE,
        UNIQUE(session_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_local_runtime_workspace_revisions_session
        ON local_runtime_workspace_indexing_revisions(session_id, sequence);

      CREATE INDEX IF NOT EXISTS idx_local_runtime_workspace_revisions_remote_work
        ON local_runtime_workspace_indexing_revisions(remote_state, next_retry_at_ms);
    `,
    },
    {
        // A sticky `skipped_limit` / `skipped_timeout` decision is only valid for
        // the collection policy that produced it: a Workspace that blew the
        // file-count limit under a narrow exclusion set can fall below it once
        // more paths are excluded. Recording that version keeps the cheap "do not
        // rescan" path for unchanged policies while forcing exactly one
        // re-evaluation after a policy update. Versions 29-33 belong to the core
        // registry in persistence/db.ts.
        version: 34,
        sql: `
      ALTER TABLE local_runtime_workspace_indexing_sessions
        ADD COLUMN policy_workspace_version TEXT;
    `,
    },
];
//# sourceMappingURL=schema.js.map