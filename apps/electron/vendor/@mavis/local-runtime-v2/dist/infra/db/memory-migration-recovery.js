import { migration as channelMigration } from './migrations/session/migration-0033-converge-channel-session-project-schema.js';
import { migration as projectMigration } from './migrations/session/migration-0034-restore-shared-project-schema-compatibility.js';
import { migration as collisionMigration } from './migrations/session/migration-0035-converge-published-schema-collisions.js';
import { migration as cronMigration } from './migrations/cron/migration-0036-repair-cron-manual-request-index.js';
import { migration as governanceMigration } from './migrations/memory/migration-0039-memory-governance-revision.js';
import { migration as executionsMigration } from './migrations/memory/migration-0040-memory-executions.js';
import { assertDatabaseSchemaConsistent } from './schema-consistency.js';
/** Test builds used 33–36 for Memory before preview_train assigned those numbers. */
export function recoverMemoryMigrationVersionCollision(database) {
    if (database.prepare('SELECT 1 FROM local_runtime_v2_schema_migrations WHERE version = 38').get() ||
        !tableExists(database, 'local_runtime_v2_memory_scopes')) {
        return;
    }
    database
        .transaction(() => {
        removeEmptyLegacyMemoryTables(database);
        for (const migration of [
            channelMigration,
            projectMigration,
            collisionMigration,
            cronMigration,
        ]) {
            applyMigration(database, migration);
        }
        const governanceColumns = database
            .prepare(`
      SELECT name FROM pragma_table_info('local_runtime_v2_memory_scopes')
      WHERE name IN ('governance_revision', 'consolidated_governance_revision')
    `)
            .all();
        if (governanceColumns.length === 0)
            applyMigration(database, governanceMigration);
        if (!tableExists(database, 'local_runtime_v2_memory_execution_tasks') &&
            !tableExists(database, 'local_runtime_v2_memory_execution_calls')) {
            applyMigration(database, executionsMigration);
        }
        // Preserve old markers and their timestamps, including a committed m37 from
        // a failed upgrade. Validate adopted objects before committing new markers.
        const record = database.prepare(`
      INSERT OR IGNORE INTO local_runtime_v2_schema_migrations (version, applied_at_ms)
      VALUES (?, ?)
    `);
        for (const version of [37, 38, 39, 40])
            record.run(version, Date.now());
        assertDatabaseSchemaConsistent(database);
    })
        .immediate();
}
function tableExists(database, name) {
    return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function applyMigration(database, migration) {
    if (typeof migration.up === 'string')
        database.exec(migration.up);
    else
        migration.up(database);
}
function removeEmptyLegacyMemoryTables(database) {
    for (const name of [
        'local_runtime_v2_memory_forget_markers',
        'local_runtime_v2_memory_items',
        'local_runtime_v2_memory_session_captures',
        'local_runtime_v2_memory_spaces',
    ]) {
        if (tableExists(database, name) && database.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()) {
            throw new Error('Memory V2 legacy data requires explicit Reset before storage rebuild');
        }
    }
    database.exec(`
    DROP TABLE IF EXISTS local_runtime_v2_memory_forget_markers;
    DROP TABLE IF EXISTS local_runtime_v2_memory_items;
    DROP TABLE IF EXISTS local_runtime_v2_memory_session_captures;
    DROP TABLE IF EXISTS local_runtime_v2_memory_spaces;
  `);
}
//# sourceMappingURL=memory-migration-recovery.js.map