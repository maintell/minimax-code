/**
 * Merge requests linked to a Session for the merge request panel. Purely
 * additive DDL: no existing row is read or rewritten, so it needs no backup.
 *
 * Version 71 follows 70 (`add_project_listed_at`), the highest version
 * `preview_train` publishes.
 */
export const migration = {
    version: 71,
    name: 'create_session_merge_requests',
    up: createSessionMergeRequests,
};
function createSessionMergeRequests(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_v2_session_merge_requests (
      session_id TEXT NOT NULL,
      ref_key TEXT NOT NULL,
      platform TEXT NOT NULL,
      host TEXT NOT NULL,
      project_path TEXT NOT NULL,
      number INTEGER NOT NULL,
      web_url TEXT NOT NULL,
      source TEXT NOT NULL,
      linked_at_ms INTEGER NOT NULL,
      removed_at_ms INTEGER,
      PRIMARY KEY (session_id, ref_key)
    )
  `);
}
//# sourceMappingURL=migration-0071-create-session-merge-requests.js.map