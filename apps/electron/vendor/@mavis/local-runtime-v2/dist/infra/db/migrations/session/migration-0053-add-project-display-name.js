/**
 * Project display names are owned by the Runtime that owns the project, so
 * every frontend (this Desktop, Remote Control consumers, phones) reads the
 * same name. The column is nullable: NULL means "use the directory basename".
 * Existing rows keep NULL; nothing is backfilled or rewritten.
 *
 * Version 53 follows 52 (`add_goal_request_and_time_limits`), which
 * `preview_train` already publishes; reusing a published number would collide
 * when the branches merge.
 */
export const migration = {
    version: 53,
    name: 'add_project_display_name',
    up: addProjectDisplayName,
};
const PROJECT_TABLE = 'local_runtime_projects';
function addProjectDisplayName(database) {
    const columns = readColumns(database, PROJECT_TABLE);
    // A missing Project table belongs to whichever repair later creates it.
    if (columns.size > 0 && !columns.has('display_name')) {
        database.exec(`ALTER TABLE ${PROJECT_TABLE} ADD COLUMN display_name TEXT`);
    }
}
function readColumns(database, table) {
    return new Set(database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === 'string'));
}
//# sourceMappingURL=migration-0053-add-project-display-name.js.map