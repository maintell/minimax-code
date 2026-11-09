import { migration as pluginMiniAppPermission } from '../plugin/migration-0050-create-plugin-miniapp-permission.js';
import { migration as goalLimits } from '../goal/migration-0052-add-goal-request-and-time-limits.js';
import { migration as backgroundTasks } from '../background-task/migration-0049-adopt-background-tasks.js';
export const migration = {
    version: 54,
    name: 'create_ppt_preview',
    up(database) {
        // An unpublished PPT build recorded its own migration as 52. The ledger is
        // version-only, so those profiles skip the train's Goal 52. Its frozen
        // definition checks existing columns and preserves every Goal row.
        if (typeof goalLimits.up === 'string')
            database.exec(goalLimits.up);
        else
            goalLimits.up(database);
        // Earlier unpublished PPT profiles used version 49 and therefore skip the
        // train's background migration. Reapply its frozen, idempotent definition
        // before creating PPT tables; existing background records remain intact.
        if (typeof backgroundTasks.up === 'string')
            database.exec(backgroundTasks.up);
        else
            backgroundTasks.up(database);
        // Unpublished PPT profiles also used version 50 before the train's plugin migration.
        // Reapply its frozen idempotent DDL so those profiles receive the permission table.
        if (typeof pluginMiniAppPermission.up === 'string')
            database.exec(pluginMiniAppPermission.up);
        else
            pluginMiniAppPermission.up(database);
        database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_ppt_preview_artifacts (artifact_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE, artifact_key TEXT NOT NULL, state_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ppt_preview_session ON local_runtime_ppt_preview_artifacts(session_id);
    CREATE TABLE IF NOT EXISTS local_runtime_ppt_preview_requests (session_id TEXT NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, PRIMARY KEY(session_id, request_id));
    CREATE TABLE IF NOT EXISTS local_runtime_ppt_preview_events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES local_runtime_sessions(session_id) ON DELETE CASCADE, artifact_id TEXT NOT NULL, event_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_ppt_preview_events_session ON local_runtime_ppt_preview_events(session_id, cursor);
  `);
    },
};
//# sourceMappingURL=migration-0054-create-ppt-preview.js.map