export const migration = {
    version: 49,
    name: 'adopt_background_tasks',
    up(database) {
        database.exec(`CREATE TABLE IF NOT EXISTS local_runtime_background_tasks (
      task_id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER, record_json TEXT NOT NULL, delivered_at_ms INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )`);
        const columns = database.prepare('PRAGMA table_info(local_runtime_background_tasks)').all();
        if (!columns.some((column) => column.name === 'delivered_at_ms')) {
            database.exec('ALTER TABLE local_runtime_background_tasks ADD COLUMN delivered_at_ms INTEGER');
        }
        if (!columns.some((column) => column.name === 'is_deleted')) {
            database.exec('ALTER TABLE local_runtime_background_tasks ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0');
        }
        database.exec(`
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_tasks_owner ON local_runtime_background_tasks(owner_session_id, created_at_ms, task_id);
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_tasks_status ON local_runtime_background_tasks(status, updated_at_ms, task_id);
      CREATE INDEX IF NOT EXISTS idx_local_runtime_background_tasks_owner_status_delivery ON local_runtime_background_tasks(owner_session_id, status, delivered_at_ms, ended_at_ms, task_id);
    `);
        // V1 migration 20 adds delivered_at_ms unconditionally on downgrade.
        // Fresh V2 databases reach this migration before V1 creates its history table.
        database.exec(`CREATE TABLE IF NOT EXISTS local_runtime_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL
    )`);
        database
            .prepare('INSERT OR IGNORE INTO local_runtime_schema_migrations (version, applied_at_ms) VALUES (?, ?)')
            .run(20, Date.now());
    },
};
//# sourceMappingURL=migration-0049-adopt-background-tasks.js.map