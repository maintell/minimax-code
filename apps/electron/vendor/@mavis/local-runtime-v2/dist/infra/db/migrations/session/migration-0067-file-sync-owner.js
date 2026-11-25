import { migration as convergeSyncsAndCron } from './migration-0066-converge-session-file-syncs-cron-scheduled-for.js';
export const migration = {
    version: 67,
    name: 'file_sync_owner',
    up(database) {
        // A development assets profile may have consumed version 66 for file_sync_owner.
        // Replay the idempotent convergence step before adding the owner column.
        const converge = convergeSyncsAndCron.up;
        if (typeof converge === 'function')
            converge(database);
        else
            database.exec(converge);
        const columns = database.prepare('PRAGMA table_info(local_runtime_session_file_syncs)').all();
        if (!columns.some((row) => typeof row === 'object' && row !== null && 'name' in row && row.name === 'account_id')) {
            database.exec('ALTER TABLE local_runtime_session_file_syncs ADD COLUMN account_id TEXT');
        }
        database.exec('CREATE INDEX IF NOT EXISTS idx_session_file_sync_node ON local_runtime_session_file_syncs (node_id)');
    },
};
//# sourceMappingURL=migration-0067-file-sync-owner.js.map