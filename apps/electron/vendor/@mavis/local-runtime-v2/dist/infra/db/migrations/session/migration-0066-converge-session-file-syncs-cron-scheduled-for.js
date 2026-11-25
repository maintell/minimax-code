import { migration as cronScheduledFor } from '../cron/migration-0065-add-cron-run-scheduled-for.js';
import { publishedSessionFileSyncsMigration65 as sessionFileSyncs } from './migration-0065-create-session-file-syncs.js';
const CRON_RUNS_TABLE = 'local_runtime_v2_cron_runs';
const SCHEDULED_FOR_COLUMN = 'scheduled_for_ms';
/**
 * Both trains published version 65: the assets lane used it for Session file
 * syncs, PreviewTrain for the Cron `scheduled_for_ms` column. `ALL_MIGRATIONS`
 * rejects duplicate versions, and a profile that already applied 65 under
 * either name never replays it, so this version applies both frozen steps.
 *
 * Session file syncs is already idempotent (`CREATE TABLE IF NOT EXISTS` plus
 * the column-guarded Goal limits replay). The Cron step is a bare
 * `ALTER TABLE ... ADD COLUMN`, so it is guarded here: a PreviewTrain profile
 * that already applied it as version 65 must not fail on a duplicate column.
 */
export const migration = {
    version: 66,
    name: 'converge_session_file_syncs_cron_scheduled_for',
    up(database) {
        applyFrozen(database, sessionFileSyncs);
        // A profile whose Cron baseline was quarantined has no cron_runs table;
        // whatever repair later creates it owns this column too.
        if (!hasTable(database, CRON_RUNS_TABLE))
            return;
        if (hasColumn(database, CRON_RUNS_TABLE, SCHEDULED_FOR_COLUMN))
            return;
        applyFrozen(database, cronScheduledFor);
    },
};
function applyFrozen(database, entry) {
    if (typeof entry.up === 'string')
        database.exec(entry.up);
    else
        entry.up(database);
}
function hasTable(database, table) {
    return (database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(table).length === 1);
}
function hasColumn(database, table, column) {
    return database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((row) => typeof row === 'object' &&
        row !== null &&
        'name' in row &&
        row.name === column);
}
//# sourceMappingURL=migration-0066-converge-session-file-syncs-cron-scheduled-for.js.map