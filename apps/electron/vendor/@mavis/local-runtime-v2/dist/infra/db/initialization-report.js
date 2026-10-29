/**
 * Every database-initialization field of the one-line startup timing record:
 * backup accounting and safe-mode state. Pure field building so the infra
 * layer stays logger-free; the runtime owns emission.
 */
export function databaseInitializationTimingFields(initialization) {
    const superseded = initialization.supersededMigrations;
    return {
        ...backupTimingFields(initialization),
        safe_mode: initialization.safeMode === true,
        superseded_migration_count: superseded?.length ?? 0,
        ...(superseded && superseded.length > 0
            ? { superseded_migration_versions: superseded.map((entry) => entry.version) }
            : {}),
        ...degradedSchemaFields(initialization),
    };
}
/**
 * Quarantined (superseded) migrations and deferred recoveries stay visible on
 * every boot until an explicit repair lands; silence would turn the accepted
 * local data degradation into an invisible one.
 */
export function migrationSafeModeWarning(initialization) {
    const superseded = initialization.supersededMigrations ?? [];
    if (initialization.safeMode !== true && superseded.length === 0)
        return undefined;
    return {
        fields: {
            safe_mode: initialization.safeMode === true,
            superseded_migrations: superseded.map((entry) => ({
                version: entry.version,
                name: entry.name,
                first_failed_at_ms: entry.firstFailedAtMs,
                last_error: entry.lastError,
            })),
            ...degradedSchemaFields(initialization),
        },
        message: 'local-runtime-v2 database initialized in safe mode; superseded migrations need a repair migration',
    };
}
/**
 * Backups are opt-in per migration entry: pending work without a backup is
 * the healthy default (`backup_skipped`), not a missed protection.
 */
function backupTimingFields(initialization) {
    const { backup, pendingVersions } = initialization;
    return {
        backup_created: backup?.created === true,
        backup_reused: backup !== undefined && backup.created === false && backup.reused === true,
        backup_skipped: (pendingVersions?.length ?? 0) > 0 &&
            backup !== undefined &&
            backup.created === false &&
            backup.reused !== true,
        ...(backup?.created
            ? {
                backup_copy_ms: backup.backupMs,
                backup_integrity_ms: backup.integrityMs,
                ...(backup.sizeBytes === undefined ? {} : { backup_size_bytes: backup.sizeBytes }),
            }
            : {}),
    };
}
function degradedSchemaFields(initialization) {
    return {
        schema_snapshot_error_count: initialization.schemaSnapshotErrorCount ?? 0,
        ...(initialization.schemaConsistencyError === undefined
            ? {}
            : { schema_consistency_error: initialization.schemaConsistencyError }),
    };
}
//# sourceMappingURL=initialization-report.js.map