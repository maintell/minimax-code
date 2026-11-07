/**
 * Marks a full-usage Goal whose cache write total is not a measurement: some
 * request charged to it came back through a route that counts cache writes
 * as input and reports a cache write of 0. Every existing Goal reads as
 * reported through the column default; only requests charged afterwards can
 * set the mark. Nothing existing is updated or deleted.
 */
export const migration = {
    version: 51,
    name: 'add_goal_cache_write_unreported',
    up: addGoalCacheWriteUnreported,
};
const GOAL_TABLE = 'local_runtime_v2_goals';
const COLUMN = 'cache_write_unreported';
function addGoalCacheWriteUnreported(database) {
    // A profile whose migration 46 was quarantined has no Goal table; whatever
    // repair later creates it owns this column too.
    const columns = new Set(database
        .prepare(`PRAGMA table_info(${GOAL_TABLE})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === 'string'));
    if (columns.size > 0 && !columns.has(COLUMN)) {
        database.exec(`ALTER TABLE ${GOAL_TABLE} ADD COLUMN ${COLUMN} INTEGER NOT NULL DEFAULT 0`);
    }
}
//# sourceMappingURL=migration-0051-add-goal-cache-write-unreported.js.map