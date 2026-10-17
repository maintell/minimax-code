export const migration = {
    version: 40,
    name: 'memory_executions',
    up(database) {
        database.exec(`
      CREATE TABLE local_runtime_v2_memory_execution_tasks (
        task_id TEXT PRIMARY KEY, stage TEXT NOT NULL, operation TEXT NOT NULL,
        source_ref TEXT, source_revision TEXT, preview_id TEXT,
        started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER,
        status TEXT NOT NULL, reason TEXT
      );
      CREATE INDEX idx_memory_execution_tasks_started ON local_runtime_v2_memory_execution_tasks(started_at_ms, task_id);
      CREATE INDEX idx_memory_execution_tasks_source ON local_runtime_v2_memory_execution_tasks(stage, source_ref, started_at_ms);
      CREATE TABLE local_runtime_v2_memory_execution_calls (
        call_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES local_runtime_v2_memory_execution_tasks(task_id),
        ordinal INTEGER NOT NULL, source_ref TEXT, model TEXT NOT NULL, reasoning_effort TEXT NOT NULL,
        started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER, stop_reason TEXT,
        input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
        cache_write_tokens INTEGER, total_tokens INTEGER
      );
      CREATE UNIQUE INDEX idx_memory_execution_calls_ordinal ON local_runtime_v2_memory_execution_calls(task_id, ordinal);
    `);
    },
};
//# sourceMappingURL=migration-0040-memory-executions.js.map