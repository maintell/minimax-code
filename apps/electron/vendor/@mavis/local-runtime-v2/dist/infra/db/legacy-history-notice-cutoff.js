import { sql } from 'drizzle-orm';
export const LEGACY_HISTORY_NOTICE_REPAIR_CUTOFF_TABLE = 'local_runtime_v2_agent_legacy_history_notice_repair';
const LEGACY_HISTORY_NOTICE_MIGRATION_VERSION = 29;
/**
 * Normal profiles retain the original m0029 boundary. Collision repair
 * profiles persist the actual later freeze time in their optional metadata.
 */
export function readLegacyHistoryNoticeCutoff(db) {
    if (repairCutoffTableExists(db))
        return readRepairCutoff(db);
    return readOriginalMigrationCutoff(db);
}
function repairCutoffTableExists(db) {
    return Boolean(db
        .all(sql `
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table'
          AND name = 'local_runtime_v2_agent_legacy_history_notice_repair'
        LIMIT 1
      `)
        .at(0));
}
function readRepairCutoff(db) {
    const row = db
        .all(sql `
      SELECT cutoff_at_ms AS cutoffAtMs
      FROM local_runtime_v2_agent_legacy_history_notice_repair
      WHERE singleton = 1
      LIMIT 1
    `)
        .at(0);
    return numericField(row, 'cutoffAtMs');
}
function readOriginalMigrationCutoff(db) {
    const row = db
        .all(sql `
      SELECT applied_at_ms AS appliedAtMs
      FROM local_runtime_v2_schema_migrations
      WHERE version = ${LEGACY_HISTORY_NOTICE_MIGRATION_VERSION}
      LIMIT 1
    `)
        .at(0);
    return numericField(row, 'appliedAtMs');
}
function numericField(value, key) {
    if (typeof value !== 'object' || value === null || !(key in value))
        return undefined;
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) ? candidate : undefined;
}
//# sourceMappingURL=legacy-history-notice-cutoff.js.map