import { copyLegacyCronRunHistory } from './migration-0002-copy-legacy-cron-data.js';
export const migration = {
    version: 4,
    name: 'copy-legacy-cron-run-history',
    up(database) {
        copyLegacyCronRunHistory(database, { warnOnOrphanedNativeRows: true });
    },
};
//# sourceMappingURL=migration-0004-copy-legacy-cron-run-history.js.map