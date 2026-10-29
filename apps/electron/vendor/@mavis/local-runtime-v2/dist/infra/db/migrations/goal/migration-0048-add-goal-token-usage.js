/**
 * Full-usage Goal token accounting. A Goal records which accounting it is
 * metered under: every Goal that exists before this migration reads as
 * version 1 (input + output of main execution) through the column default,
 * and only Goals created afterwards are written as version 2, which also
 * keeps the four token parts. Usage of requests outside the request ledger
 * (automatic compaction in a Goal Turn, sub-sessions a Goal Turn started, the
 * subagent verifier) is charged through a table of its own, one row per
 * logical request. Nothing existing is updated or deleted.
 */
export const migration = {
    version: 48,
    name: 'add_goal_token_usage',
    up: addGoalTokenUsage,
};
const GOAL_TABLE = 'local_runtime_v2_goals';
const GOAL_COLUMNS = [
    ['token_accounting_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['input_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['cache_write_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0'],
    ['output_tokens', 'INTEGER NOT NULL DEFAULT 0'],
];
function addGoalTokenUsage(database) {
    // A profile whose migration 46 was quarantined has no Goal table; whatever
    // repair later creates it owns these columns too.
    const columns = readColumns(database, GOAL_TABLE);
    for (const [name, definition] of GOAL_COLUMNS) {
        if (columns.size > 0 && !columns.has(name)) {
            database.exec(`ALTER TABLE ${GOAL_TABLE} ADD COLUMN ${name} ${definition}`);
        }
    }
    database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_v2_goal_token_charges (
      request_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      source TEXT NOT NULL,
      phase TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      usage_incomplete INTEGER NOT NULL DEFAULT 0,
      discard_reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_token_charges_goal
      ON local_runtime_v2_goal_token_charges (goal_id, phase);
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_token_charges_session
      ON local_runtime_v2_goal_token_charges (session_id);
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_token_charges_updated
      ON local_runtime_v2_goal_token_charges (updated_at_ms);
  `);
}
function readColumns(database, table) {
    return new Set(database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === 'string'));
}
//# sourceMappingURL=migration-0048-add-goal-token-usage.js.map