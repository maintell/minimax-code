import { migration as sessionResourcesMigration } from '../session/migration-0025-create-session-resources.js';
function hasCronColumn(database, name) {
    return database
        .prepare('PRAGMA table_info(local_runtime_v2_cron_definitions)')
        .all()
        .some((row) => typeof row === 'object' &&
        row !== null &&
        'name' in row &&
        row.name === name);
}
function hasTable(database, name) {
    return (database
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .all(name).length === 1);
}
function hasAppliedVersion(database, version) {
    return (hasTable(database, 'local_runtime_v2_schema_migrations') &&
        database
            .prepare('SELECT version FROM local_runtime_v2_schema_migrations WHERE version = ?')
            .all(version).length === 1);
}
/**
 * The SSH feature branch used version 25 for Cron config before integration, while the
 * Remote Control branch used it for Session resources. Repair that exact branch-only
 * history before version 26 attempts to replace a Session-resource index.
 */
export function repairCronSessionResourcesVersionCollision(database) {
    const isCronVersion25History = hasAppliedVersion(database, 25) &&
        !hasTable(database, 'session_resources') &&
        !hasTable(database, 'session_turn_resources') &&
        hasCronColumn(database, 'project') &&
        hasCronColumn(database, 'model');
    if (!isCronVersion25History)
        return false;
    if (typeof sessionResourcesMigration.up !== 'string') {
        throw new Error('Session resources migration must remain frozen SQL');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
        database.exec(sessionResourcesMigration.up);
        database.exec('COMMIT');
        return true;
    }
    catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}
//# sourceMappingURL=migration-0033-repair-cron-session-resources-version-collision.js.map