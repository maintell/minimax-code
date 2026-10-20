import { createDatabaseBackupIfPending, pruneSupersededDatabaseBackups, } from './backup.js';
import { runMigrations, runMigrationsWithRecovery, } from './migrate.js';
import { ALL_MIGRATIONS } from './migrations.js';
import { isMemoryMigrationVersionCollisionPending, recoverMemoryMigrationVersionCollision, } from './memory-migration-recovery.js';
import { applyBackupOverlay } from './migration-backup-overlay.js';
import { migration as queryCollapseMigration } from './migrations/session/migration-0016-create-query-collapse-view-states.js';
import { quarantineMigrations, readMigrationQuarantine, } from './migration-quarantine.js';
import { assertDatabaseSchemaConsistent } from './schema-consistency.js';
import { ensureSchemaSnapshot } from './safe-mode-snapshot-ensure.js';
import { disableLegacyCronsWithoutFutureRun } from './legacy-cron-recovery.js';
import { repairCronSessionResourcesVersionCollision } from './migrations/cron/migration-0033-repair-cron-session-resources-version-collision.js';
import { recoverLegacySessionRecordsBeforeBackfill } from './legacy-session-recovery.js';
import { recoverProjectPreferencesBeforeBackfill, recoverSessionProjectMetadataBeforeRepair, } from './project-migration-recovery.js';
// Startup reporting over the result belongs to the initializer's surface, so
// the runtime composition root keeps depending on this module only.
export { databaseInitializationTimingFields, migrationSafeModeWarning, } from './initialization-report.js';
/**
 * The PRE_SESSION strict lanes (legacy cron copy, session backfill) cover the
 * catalog versions below this bound; later versions run in the main schema
 * chain under safe-mode.
 */
const STRICT_LANE_VERSION_END = 15;
/**
 * Database initialization with scoped safe-mode: a failure in the main
 * full-catalog schema chain is retried once in the same boot, then
 * quarantined (superseded) and skipped forever; the idempotent schema
 * snapshot backfills missing structure and the version table stays honest.
 * The dedicated data-migration lanes (legacy cron copy, session backfill —
 * the PRE_SESSION slices) keep their strict fail-stop contract: atomic
 * rollback, rejection, natural retry after the legacy data is repaired.
 * Backups are opt-in per migration entry. A main-chain entry that demands a
 * backup which cannot be produced is quarantined instead of running bare; a
 * strict lane that demands one fails startup and retries on the next boot.
 * See `.harness/docs/adr/local-runtime-migration-fault-tolerance.md`.
 */
export async function initializeDatabase(options) {
    const startedAtMs = Date.now();
    const catalog = resolveMigrationCatalog(options.migrations);
    const applied = readAppliedVersions(options.database);
    const previouslySuperseded = readMigrationQuarantine(options.dataDir);
    const skipVersions = new Set(previouslySuperseded.map((entry) => entry.version));
    const pendingEntries = catalog.filter((migration) => !applied.has(migration.version) && !skipVersions.has(migration.version));
    const pendingVersions = pendingEntries.map((migration) => migration.version);
    const appliedMaxVersion = applied.size > 0 ? Math.max(...applied) : 0;
    // Opening the connection / reading version metadata precedes this interval.
    // Measure backup, recovery, all pending migrations and final schema validation.
    const startedAtEpochMs = options.onMigration ? migrationEpochNow() : undefined;
    reportDatabaseMigration(options.onMigration, 'started', startedAtEpochMs, pendingVersions.length);
    try {
        // --- Opt-in campaign backup -----------------------------------------------
        const backupStartedAtMs = Date.now();
        const quarantineCandidates = [];
        const memoryCollisionPending = isMemoryMigrationVersionCollisionPending(options.database.rawDb);
        const backup = await runOptInBackupStage({
            database: options.database,
            dataDir: options.dataDir,
            pendingEntries,
            appliedMaxVersion,
            pendingVersions,
            skipVersions,
            quarantineCandidates,
            memoryCollisionPending,
        });
        const backupMs = Math.max(0, Date.now() - backupStartedAtMs);
        // --- Staged migration execution -------------------------------------------
        // Scope contract: the two PRE_SESSION slices below keep the strict
        // fail-stop semantics (atomic rollback, initializeDatabase rejects, natural
        // retry on the next boot once the underlying data is repaired) because
        // their failures are data-repairable migration lanes — legacy cron copy and
        // session backfill — with their own product contracts. Safe-mode
        // (same-boot retry once, then quarantine and continue) applies only to the
        // final full-catalog pass, the 3.0.69 incident chain.
        const executableVersions = new Set(pendingVersions.filter((version) => !skipVersions.has(version)));
        const strictSlice = (maxExclusiveVersion) => catalog.filter((migration) => migration.version < maxExclusiveVersion && !skipVersions.has(migration.version));
        const migrationsStartedAtMs = Date.now();
        const disabledLegacyScheduleCount = disableLegacyCronsWithoutFutureRun({
            database: options.database,
            version2Pending: executableVersions.has(2),
        });
        runMigrations(options.database.rawDb, strictSlice(7));
        const recoveredProjectPreferenceCount = recoverProjectPreferencesBeforeBackfill({
            database: options.database,
            version7Pending: executableVersions.has(7),
        });
        const sessionRecovery = recoverLegacySessionRecordsBeforeBackfill({
            database: options.database,
            version7Pending: executableVersions.has(7),
        });
        runMigrations(options.database.rawDb, strictSlice(STRICT_LANE_VERSION_END));
        const skippedSessionProjectRepairCount = recoverSessionProjectMetadataBeforeRepair({
            database: options.database,
            version15Pending: executableVersions.has(15),
        });
        recoverPublishedCronQueryCollapseCollision({
            database: options.database,
            migration16Applied: applied.has(16),
            migration32Pending: executableVersions.has(32),
        });
        // Dedicated collision lane like the one above: additive frozen DDL that
        // keeps strict failure semantics, run before the `<37` prefix.
        repairCronSessionResourcesVersionCollision(options.database.rawDb);
        runMainSchemaChain({
            database: options.database,
            catalog,
            skipVersions,
            quarantineCandidates,
        });
        const migrationsMs = Math.max(0, Date.now() - migrationsStartedAtMs);
        // --- Quarantine persistence + safe-mode schema ensure ----------------------
        const supersededMigrations = quarantineCandidates.length > 0
            ? quarantineMigrations(options.dataDir, quarantineCandidates)
            : previouslySuperseded;
        const schemaCheckStartedAtMs = Date.now();
        // Safe-mode is a property of the merged quarantine state, not of this
        // boot's new failures: a warm boot over a persisted superseded migration
        // still runs a schema that never received that migration.
        const schemaSafety = runSchemaSafetyStage(options.database, {
            supersededPresent: supersededMigrations.length > 0,
        });
        const schemaCheckMs = Math.max(0, Date.now() - schemaCheckStartedAtMs);
        reportDatabaseMigration(options.onMigration, 'completed', startedAtEpochMs, pendingVersions.length);
        return {
            pendingVersions,
            backup,
            timings: {
                totalMs: Math.max(0, Date.now() - startedAtMs),
                backupMs,
                migrationsMs,
                schemaCheckMs,
            },
            ...(backup.created
                ? {
                    pruneBackups: () => pruneSupersededDatabaseBackups({ dataDir: options.dataDir, retainedBackup: backup }),
                }
                : {}),
            disabledLegacyScheduleCount,
            recoveredLegacySessionCount: sessionRecovery.recoveredCount,
            degradedLegacySessionCount: sessionRecovery.degradedCount,
            recoveredProjectPreferenceCount,
            skippedSessionProjectRepairCount,
            supersededMigrations,
            safeMode: schemaSafety.safeMode,
            schemaSnapshotErrorCount: schemaSafety.snapshotErrorCount,
            ...(schemaSafety.schemaConsistencyError === undefined
                ? {}
                : { schemaConsistencyError: schemaSafety.schemaConsistencyError }),
        };
    }
    catch (error) {
        reportDatabaseMigration(options.onMigration, 'failed', startedAtEpochMs, pendingVersions.length);
        throw error;
    }
}
/**
 * The backup overlay re-attaches `backup: true` to the frozen shipped
 * entries that rewrite user data. The test seam stays a verbatim override
 * so failure-path scenarios keep exact control over which entries demand a
 * backup; production always takes the overlaid shipped catalog.
 */
function resolveMigrationCatalog(override) {
    return override ?? applyBackupOverlay(ALL_MIGRATIONS);
}
/**
 * Opt-in campaign backup: runs only when a pending entry declares
 * `backup: true` or the Memory collision adoption (which replays the lossy
 * m33) is pending. When the backup cannot be produced (disk preflight, copy,
 * or verification failure), demanding main-chain entries are quarantined
 * instead of running bare while the rest of the pending set still executes;
 * a demand from a strict lane fails startup instead (see the catch).
 */
async function runOptInBackupStage(stage) {
    const demandingEntries = stage.pendingEntries.filter((migration) => migration.backup === true);
    if (demandingEntries.length === 0 && !stage.memoryCollisionPending) {
        return { created: false };
    }
    try {
        return await createDatabaseBackupIfPending({
            database: stage.database,
            dataDir: stage.dataDir,
            campaign: {
                appliedMaxVersion: stage.appliedMaxVersion,
                pendingVersions: stage.pendingVersions,
            },
        });
    }
    catch (error) {
        // Strict lanes keep their fail-stop contract for a missing backup too.
        // A pending Memory collision adoption must not run without its recovery
        // point, and deferring it would let later catalog migrations run over the
        // 37–40 hole with the snapshot ensure disabled. A PRE_SESSION entry (the
        // session backfill and its follow-ups) must not be superseded either: its
        // lane skips superseded versions and the snapshot ensure restores only
        // DDL, so unconverted Sessions would stay unreadable for good. Refuse
        // startup instead, like a failure inside the lane itself: the cause is
        // transient (disk space, copy error) and the next boot retries naturally.
        const strictLaneDemand = demandingEntries.some((migration) => migration.version < STRICT_LANE_VERSION_END);
        if (stage.memoryCollisionPending || strictLaneDemand)
            throw error;
        for (const migration of demandingEntries) {
            stage.quarantineCandidates.push({
                version: migration.version,
                name: migration.name,
                error,
            });
            stage.skipVersions.add(migration.version);
        }
        return { created: false };
    }
}
/**
 * Main schema chain (the 3.0.69 incident surface): same-boot retry, then
 * quarantine. The Memory version-collision adoption runs between the
 * pre-Memory prefix and the rest and keeps its own strict contract (atomic
 * rollback, startup rejection until the user resets non-empty legacy Memory
 * data), like the PRE_SESSION lanes; reaching this point implies its backup
 * demand was satisfied (a missing backup already failed startup).
 */
function runMainSchemaChain(chain) {
    const quarantineFailures = (failures) => {
        for (const failure of failures) {
            chain.quarantineCandidates.push({
                version: failure.version,
                name: failure.name,
                error: failure.error,
            });
            chain.skipVersions.add(failure.version);
        }
    };
    const rawDb = chain.database.rawDb;
    const skipVersions = chain.skipVersions;
    const preMemory = chain.catalog.filter((migration) => migration.version < 37);
    quarantineFailures(runMigrationsWithRecovery(rawDb, preMemory, { skipVersions }).failures);
    recoverMemoryMigrationVersionCollision(rawDb);
    quarantineFailures(runMigrationsWithRecovery(rawDb, chain.catalog, { skipVersions }).failures);
}
/**
 * Safe-mode schema safety: replay the idempotent snapshot whenever any
 * superseded migration exists — newly quarantined this boot or persisted
 * from an earlier one — then verify consistency. The warm-boot replay is
 * deliberate: a persistently superseded migration never runs again, so the
 * snapshot ensure is the only mechanism that backfills its structure, and
 * re-running it keeps the schema converged with the *current* build's
 * snapshot after app updates. An inconsistent schema is ensured once and
 * rechecked; a still-failing recheck is recorded instead of thrown —
 * startup never bricks over schema divergence.
 */
function runSchemaSafetyStage(database, state) {
    const supersededPresent = state.supersededPresent;
    let snapshotErrorCount = 0;
    let safeMode = false;
    let schemaConsistencyError;
    if (supersededPresent) {
        safeMode = true;
        snapshotErrorCount += ensureSchemaSnapshot(database.rawDb).errors.length;
    }
    try {
        assertDatabaseSchemaConsistent(database.rawDb);
    }
    catch (error) {
        if (safeMode) {
            // The ensure already ran for this boot; the assert above is the recheck.
            schemaConsistencyError = describeError(error);
        }
        else {
            safeMode = true;
            snapshotErrorCount += ensureSchemaSnapshot(database.rawDb).errors.length;
            try {
                assertDatabaseSchemaConsistent(database.rawDb);
            }
            catch (recheckError) {
                schemaConsistencyError = describeError(recheckError);
            }
        }
    }
    return {
        safeMode,
        snapshotErrorCount,
        ...(schemaConsistencyError === undefined ? {} : { schemaConsistencyError }),
    };
}
/**
 * A published Cron branch occupied version 16 without creating the Session
 * query-collapse table. Restore that immutable prerequisite before canonical
 * m32 reads it, without changing the historic marker.
 */
function recoverPublishedCronQueryCollapseCollision(options) {
    if (!options.migration16Applied ||
        !options.migration32Pending ||
        tableExists(options.database, 'local_runtime_query_view_states') ||
        !tableHasColumns(options.database, 'local_runtime_v2_cron_definitions', ['project', 'model'])) {
        return;
    }
    options.database.rawDb.transaction(() => {
        if (typeof queryCollapseMigration.up === 'string') {
            options.database.rawDb.exec(queryCollapseMigration.up);
        }
        else {
            queryCollapseMigration.up(options.database.rawDb);
        }
    })();
}
function tableExists(database, tableName) {
    return Boolean(database.rawDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(tableName));
}
function tableHasColumns(database, tableName, columnNames) {
    const columns = new Set(database.rawDb
        .prepare(`PRAGMA table_info(${tableName})`)
        .all()
        .flatMap((row) => typeof row === 'object' && row !== null && 'name' in row && typeof row.name === 'string'
        ? [row.name]
        : []));
    return columnNames.every((columnName) => columns.has(columnName));
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function readAppliedVersions(database) {
    const table = database.rawDb
        .prepare(`SELECT 1 AS present FROM sqlite_master
       WHERE type = 'table' AND name = 'local_runtime_v2_schema_migrations'`)
        .get();
    if (!table)
        return new Set();
    const rows = database.rawDb
        .prepare('SELECT version FROM local_runtime_v2_schema_migrations')
        .all();
    return new Set(rows.map((row) => {
        const value = typeof row === 'object' && row !== null && 'version' in row
            ? row.version
            : undefined;
        if (!Number.isSafeInteger(value))
            throw new Error('Invalid v2 migration history');
        return value;
    }));
}
function migrationEpochNow() {
    try {
        const value = performance.timeOrigin + performance.now();
        return Number.isFinite(value) && value >= 0 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function reportDatabaseMigration(observer, phase, startedAtEpochMs, pendingMigrationCount) {
    try {
        if (!observer || startedAtEpochMs === undefined)
            return;
        const now = migrationEpochNow();
        if (now === undefined || now < startedAtEpochMs)
            return;
        const common = { startedAtEpochMs, pendingMigrationCount };
        observer(phase === 'started'
            ? { ...common, phase }
            : {
                ...common,
                phase,
                durationMs: Math.round((now - startedAtEpochMs) * 1000) / 1000,
            });
    }
    catch {
        // Synchronous notification only: never wait for delivery or replace a DB error.
    }
}
//# sourceMappingURL=initialize.js.map