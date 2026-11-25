/**
 * The sidebar lists projects in a stable order instead of by their latest activity, so adding,
 * moving or running a task no longer reorders them. `listed_at_ms` is when a project joined the
 * list; rows written later without it (for example by the v5 Session triggers) rank by
 * `created_at_ms`, so a new project still comes first. Existing rows take the activity sort key
 * the list used until now (persisted activity, upstream Channel activity, creation time), so the
 * order a user sees is kept across the upgrade. Older builds ignore the nullable column.
 *
 * Version 70 follows 69 (`create_skill_usage`), which `preview_train` already publishes.
 */
export const migration = {
    version: 70,
    name: 'add_project_listed_at',
    up: addProjectListedAt,
};
/** The sort key of the project list before this migration, Channel Sessions included. */
const FREEZE_ORDER_WITH_CHANNEL_ACTIVITY = `
  UPDATE local_runtime_projects
  SET listed_at_ms = MAX(
    latest_activity_at_ms,
    COALESCE((
      SELECT MAX(s.updated_at_ms)
      FROM local_runtime_sessions s
      WHERE s.project_id = local_runtime_projects.project_id
        AND s.columnar_version = 3
        AND s.archived = 0
        AND s.visibility <> 'hidden'
        AND s.session_kind = 'channel'
    ), 0),
    created_at_ms
  )
  WHERE listed_at_ms IS NULL
`;
const FREEZE_ORDER = `
  UPDATE local_runtime_projects
  SET listed_at_ms = MAX(latest_activity_at_ms, created_at_ms)
  WHERE listed_at_ms IS NULL
`;
function addProjectListedAt(database) {
    const projectColumns = readColumns(database, 'local_runtime_projects');
    // A missing Project table belongs to whichever repair later creates it.
    if (projectColumns.size === 0)
        return;
    if (!projectColumns.has('listed_at_ms')) {
        database.exec('ALTER TABLE local_runtime_projects ADD COLUMN listed_at_ms INTEGER');
    }
    database.exec(readColumns(database, 'local_runtime_sessions').size > 0
        ? FREEZE_ORDER_WITH_CHANNEL_ACTIVITY
        : FREEZE_ORDER);
}
function readColumns(database, table) {
    return new Set(database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === 'string'));
}
//# sourceMappingURL=migration-0070-add-project-listed-at.js.map