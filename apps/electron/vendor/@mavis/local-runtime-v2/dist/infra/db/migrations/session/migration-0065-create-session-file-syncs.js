import { migration as goalRequestAndTimeLimits } from '../goal/migration-0052-add-goal-request-and-time-limits.js';
/**
 * Records which local Session file was uploaded to which cloud asset node. Keyed by the
 * file's real path; `size`/`mtime_ms` are the file's stat when `sha256` was known to match it.
 *
 * Assets lane builds shipped this table as version 52, which PreviewTrain uses for the Goal
 * request/time limits. Those profiles already hold the table but skipped the Goal columns, so
 * this version also re-applies the frozen version 52 Goal migration; both steps are idempotent.
 *
 * PreviewTrain published its own version 65 (`cron_run_scheduled_for`), and
 * `ALL_MIGRATIONS` rejects duplicate versions, so this module is no longer a
 * registry entry: version 66 replays it verbatim alongside the Cron column.
 * The export name deliberately avoids `migration` so the freeze check treats
 * this as a frozen support module, the same shape as
 * `migration-0042-repair-rc-channel-surface-version-collision.ts`.
 */
export const publishedSessionFileSyncsMigration65 = {
    version: 65,
    name: 'create_session_file_syncs',
    up: createSessionFileSyncs,
};
function createSessionFileSyncs(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_session_file_syncs (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      node_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      drive_path TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, path)
    );
  `);
    const goalUp = goalRequestAndTimeLimits.up;
    if (typeof goalUp === 'function')
        goalUp(database);
    else
        database.exec(goalUp);
}
//# sourceMappingURL=migration-0065-create-session-file-syncs.js.map