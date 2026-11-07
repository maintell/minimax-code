/**
 * Moves Goal ownership to local-runtime-v2.
 *
 * The v1 table `local_runtime_thread_goals` is only read here: every row is copied
 * as-is into `local_runtime_v2_goals`, which the v2 Goal owner reads and writes
 * from then on. The legacy table is left in place, untouched, so a failed or
 * rolled-back upgrade never loses Goal data. Columns that an old profile never
 * received through v1's additive compatibility pass take the same defaults v1
 * would have written.
 *
 * Unreleased Goal builds created this table under version 43 (see migration
 * 45). Such a profile already has the table and its live rows: it only gains
 * the columns added since, and the legacy rows are never copied over it again
 * (they would resurrect Goals deleted since).
 */
export const migration = {
    version: 46,
    name: 'create_goal_owner_table',
    up: createGoalOwnerTable,
};
const GOAL_TABLE = 'local_runtime_v2_goals';
const LEGACY_TABLE = 'local_runtime_thread_goals';
/** Columns copied from the legacy row, with the default used when a profile lacks them. */
const COPIED_COLUMNS = [
    ['goal_id', 'NULL'],
    ['session_id', 'NULL'],
    ['objective', 'NULL'],
    ['status', 'NULL'],
    ['status_reason', 'NULL'],
    ['created_at_ms', '0'],
    ['updated_at_ms', '0'],
    ['tokens_used', '0'],
    ['turns_used', '0'],
    ['time_used_seconds', '0'],
    ['token_budget', 'NULL'],
    ['objective_resources_json', "'[]'"],
    ['kickoff_attachments_json', "'[]'"],
    ['kickoff_state', "'consumed'"],
    ['reply_fingerprint', 'NULL'],
    ['no_progress_streak', '0'],
    ['no_tool_streak', '0'],
    ['last_verification', 'NULL'],
    ['last_worker_proposal', 'NULL'],
    ['execution_wait_reason', 'NULL'],
    ['execution_wait_since_ms', 'NULL'],
    ['execution_wait_epoch', 'NULL'],
    ['usage_recovery_at_ms', 'NULL'],
    ['dismissed_at_ms', 'NULL'],
];
function createGoalOwnerTable(database) {
    if (tableExists(database, GOAL_TABLE)) {
        addMissingColumns(database);
        return;
    }
    database.exec(`
    CREATE TABLE ${GOAL_TABLE} (
      goal_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      turns_used INTEGER NOT NULL DEFAULT 0,
      time_used_seconds INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER,
      objective_resources_json TEXT NOT NULL DEFAULT '[]',
      kickoff_attachments_json TEXT NOT NULL DEFAULT '[]',
      kickoff_state TEXT NOT NULL DEFAULT 'consumed',
      reply_fingerprint TEXT,
      no_progress_streak INTEGER NOT NULL DEFAULT 0,
      no_tool_streak INTEGER NOT NULL DEFAULT 0,
      last_verification TEXT,
      last_worker_proposal TEXT,
      execution_wait_reason TEXT,
      execution_wait_since_ms INTEGER,
      execution_wait_epoch INTEGER,
      usage_recovery_at_ms INTEGER,
      dismissed_at_ms INTEGER
    );
    CREATE UNIQUE INDEX idx_local_runtime_v2_goals_session
      ON local_runtime_v2_goals (session_id);
    CREATE INDEX idx_local_runtime_v2_goals_kickoff_state
      ON local_runtime_v2_goals (kickoff_state, session_id);
  `);
    const legacyColumns = readLegacyColumns(database);
    if (legacyColumns.size === 0)
        return;
    const selected = COPIED_COLUMNS.map(([name, fallbackSql]) => legacyColumns.has(name) ? name : `${fallbackSql} AS ${name}`);
    database.exec(`
    INSERT INTO ${GOAL_TABLE} (${COPIED_COLUMNS.map(([name]) => name).join(', ')})
    SELECT ${selected.join(', ')}
    FROM ${LEGACY_TABLE}
    WHERE goal_id IS NOT NULL
      AND session_id IS NOT NULL
      AND objective IS NOT NULL
      AND status IS NOT NULL
  `);
}
/** Columns added after unreleased builds created the table under version 43. */
const LATER_COLUMNS = [
    ['dismissed_at_ms', 'INTEGER'],
];
function addMissingColumns(database) {
    const columns = readColumns(database, GOAL_TABLE);
    for (const [name, definition] of LATER_COLUMNS) {
        if (!columns.has(name)) {
            database.exec(`ALTER TABLE ${GOAL_TABLE} ADD COLUMN ${name} ${definition}`);
        }
    }
}
function readLegacyColumns(database) {
    return tableExists(database, LEGACY_TABLE) ? readColumns(database, LEGACY_TABLE) : new Set();
}
function tableExists(database, table) {
    return (database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).all(table)
        .length > 0);
}
function readColumns(database, table) {
    return new Set(database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === 'string'));
}
//# sourceMappingURL=migration-0046-create-goal-owner-table.js.map