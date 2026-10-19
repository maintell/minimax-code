export const CRON_MIGRATIONS = [
    {
        version: 23,
        sql: `
      CREATE TABLE IF NOT EXISTS local_runtime_cron_legacy_imports (
        agent_name TEXT NOT NULL,
        cron_name TEXT NOT NULL,
        imported_at_ms INTEGER NOT NULL,
        PRIMARY KEY (agent_name, cron_name)
      );
    `,
    },
    {
        version: 24,
        sql: `
      CREATE TABLE IF NOT EXISTS local_runtime_cron_data_migrations (
        migration_key TEXT PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL,
        details_json TEXT
      );
    `,
    },
];
//# sourceMappingURL=schema.js.map