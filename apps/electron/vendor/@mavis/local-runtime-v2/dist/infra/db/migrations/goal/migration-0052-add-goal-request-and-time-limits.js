/**
 * Per-Goal request and time limits. Until now only the token cap was stored
 * per Goal; the request cap and the active-time cap came from the global
 * config alone. Both new columns are nullable with no default value, so every
 * Goal that exists before this migration reads as "no own limit" and keeps
 * using the global defaults exactly as before. Nothing existing is updated.
 */
export const migration = {
    version: 52,
    name: 'add_goal_request_and_time_limits',
    up: addGoalRequestAndTimeLimits,
};
const GOAL_TABLE = 'local_runtime_v2_goals';
const GOAL_COLUMNS = [
    ['request_limit', 'INTEGER'],
    ['active_seconds_limit', 'INTEGER'],
];
function addGoalRequestAndTimeLimits(database) {
    // A profile whose migration 46 was quarantined has no Goal table; whatever
    // repair later creates it owns these columns too.
    const columns = readColumns(database, GOAL_TABLE);
    for (const [name, definition] of GOAL_COLUMNS) {
        if (columns.size > 0 && !columns.has(name)) {
            database.exec(`ALTER TABLE ${GOAL_TABLE} ADD COLUMN ${name} ${definition}`);
        }
    }
}
function readColumns(database, table) {
    return new Set(database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((row) => row.name)
        .filter((name) => typeof name === 'string'));
}
//# sourceMappingURL=migration-0052-add-goal-request-and-time-limits.js.map