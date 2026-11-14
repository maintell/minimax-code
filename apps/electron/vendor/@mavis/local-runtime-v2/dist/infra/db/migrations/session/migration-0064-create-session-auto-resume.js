/**
 * Session-scoped "continue when the Token Plan quota resets" plans. Rows are
 * written only by the local Runtime that owns the Session and are deleted as
 * soon as the plan fires, is superseded by the user, or expires.
 *
 * Version 64 follows 63 (`hidden_session_purpose_index`), which `preview_train`
 * already publishes; reusing a published number would collide on merge.
 */
export const migration = {
    version: 64,
    name: 'create_session_auto_resume',
    up: createSessionAutoResume,
};
function createSessionAutoResume(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_v2_session_auto_resume (
      session_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      resume_at_ms INTEGER NOT NULL,
      interrupted_at_ms INTEGER NOT NULL,
      auto_retry_count INTEGER NOT NULL DEFAULT 0,
      model_name TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )
  `);
}
//# sourceMappingURL=migration-0064-create-session-auto-resume.js.map