/**
 * Adds the Goal request ledger: one row per logical LLM request of Goal main
 * execution. Existing Goals keep `turns_used` as their frozen pre-upgrade
 * occupancy; nothing is backfilled, so historical turns are never presented
 * as sent requests. Unreleased Goal builds created the same ledger under
 * version 44 (see migration 45), so every statement tolerates an existing ledger.
 */
export const migration = {
    version: 47,
    name: 'create_goal_request_ledger',
    up: createGoalRequestLedger,
};
function createGoalRequestLedger(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_v2_goal_requests (
      request_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_requests_goal
      ON local_runtime_v2_goal_requests (goal_id, kind, phase);
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_requests_turn
      ON local_runtime_v2_goal_requests (turn_id, kind);
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_requests_session
      ON local_runtime_v2_goal_requests (session_id);
    CREATE INDEX IF NOT EXISTS idx_local_runtime_v2_goal_requests_updated
      ON local_runtime_v2_goal_requests (updated_at_ms);
  `);
}
//# sourceMappingURL=migration-0047-create-goal-request-ledger.js.map