/**
 * 运行时 migration runner。
 *
 * 设计选择：不依赖 drizzle-kit 运行时；migration SQL 手写并声明在代码中。
 * drizzle-kit 仅在 dev 时用于 diff schema → 生成 SQL 草稿。
 *
 * 为什么不用 drizzle-kit migrate()：
 * 1. drizzle-kit 运行时需要 fs 读取 migration 目录，Electron asar 不友好。
 * 2. 我们需要与 v1 数据共存，部分 migration 是 data backfill，不是纯 DDL。
 * 3. 保持最小运行时依赖：只有 drizzle-orm + better-sqlite3。
 *
 * @public Strict fail-fast runner. Production startup goes through
 * runMigrationsWithRecovery; this remains the dist API for the rehearsal
 * scripts (`scripts/session-storage-real-data-rehearsal.mjs`), the schema
 * snapshot generator, and focused tests that need exact-throw semantics.
 */
export function runMigrations(rawDb, migrations) {
    validateMigrationEntries(migrations);
    // 确保 meta 表存在
    ensureMigrationHistoryTable(rawDb);
    const applied = readAppliedVersionSet(rawDb);
    for (const migration of migrations) {
        if (applied.has(migration.version))
            continue;
        rawDb.exec('BEGIN IMMEDIATE');
        try {
            if (isMigrationApplied(rawDb, migration.version)) {
                rawDb.exec('COMMIT');
                applied.add(migration.version);
                continue;
            }
            if (typeof migration.up === 'string') {
                rawDb.exec(migration.up);
            }
            else {
                migration.up(rawDb);
            }
            rawDb
                .prepare('INSERT INTO local_runtime_v2_schema_migrations (version, applied_at_ms) VALUES (?, ?)')
                .run(migration.version, Date.now());
            rawDb.exec('COMMIT');
            applied.add(migration.version);
        }
        catch (err) {
            rawDb.exec('ROLLBACK');
            throw err;
        }
    }
}
/**
 * Safe-mode migration runner: apply each pending entry, retry a failed entry
 * once within the same boot (the cross-process migration lock is still held,
 * so nothing wrote to the database between the attempts and a transient
 * failure gets a second chance), and record a deterministic failure instead
 * of throwing so the remaining pending entries still run. Entries listed in
 * `skipVersions` (the persisted quarantine list) are never attempted and are
 * never written into the version table.
 * See `.harness/docs/adr/local-runtime-migration-fault-tolerance.md`.
 */
export function runMigrationsWithRecovery(rawDb, migrations, options = {}) {
    validateMigrationEntries(migrations);
    ensureMigrationHistoryTable(rawDb);
    const applied = readAppliedVersionSet(rawDb);
    const failures = [];
    for (const migration of migrations) {
        if (applied.has(migration.version))
            continue;
        if (options.skipVersions?.has(migration.version))
            continue;
        try {
            applyMigrationOnce(rawDb, migration);
        }
        catch {
            try {
                applyMigrationOnce(rawDb, migration);
            }
            catch (retryError) {
                failures.push({ version: migration.version, name: migration.name, error: retryError });
                continue;
            }
        }
        applied.add(migration.version);
    }
    return { failures };
}
/** One transactional attempt at a single migration entry. */
function applyMigrationOnce(rawDb, migration) {
    rawDb.exec('BEGIN IMMEDIATE');
    try {
        if (isMigrationApplied(rawDb, migration.version)) {
            rawDb.exec('COMMIT');
            return;
        }
        if (typeof migration.up === 'string') {
            rawDb.exec(migration.up);
        }
        else {
            migration.up(rawDb);
        }
        rawDb
            .prepare('INSERT INTO local_runtime_v2_schema_migrations (version, applied_at_ms) VALUES (?, ?)')
            .run(migration.version, Date.now());
        rawDb.exec('COMMIT');
    }
    catch (err) {
        try {
            rawDb.exec('ROLLBACK');
        }
        catch {
            // Some SQLite errors abort the transaction on their own; a rollback on
            // an already-closed transaction must not mask the original failure.
        }
        throw err;
    }
}
function ensureMigrationHistoryTable(rawDb) {
    rawDb.exec(`
    CREATE TABLE IF NOT EXISTS local_runtime_v2_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at_ms INTEGER NOT NULL
    );
  `);
}
function readAppliedVersionSet(rawDb) {
    const applied = new Set();
    for (const row of rawDb.prepare('SELECT version FROM local_runtime_v2_schema_migrations').all()) {
        if (!isVersionRow(row))
            throw new Error('Invalid v2 schema migration history row');
        applied.add(row.version);
    }
    return applied;
}
function isMigrationApplied(rawDb, version) {
    const rows = rawDb
        .prepare('SELECT version FROM local_runtime_v2_schema_migrations WHERE version = ?')
        .all(version);
    if (rows.length === 0)
        return false;
    if (rows.length !== 1 || !isVersionRow(rows[0])) {
        throw new Error('Invalid v2 schema migration history row');
    }
    return true;
}
function validateMigrationEntries(migrations) {
    const versions = new Set();
    const names = new Set();
    let previousVersion = 0;
    for (const migration of migrations) {
        if (!Number.isSafeInteger(migration.version) || migration.version <= 0) {
            throw new Error(`Invalid migration version: ${migration.version}`);
        }
        if (migration.name.trim().length === 0) {
            throw new Error(`Migration ${migration.version} has an empty name`);
        }
        if (versions.has(migration.version)) {
            throw new Error(`Duplicate migration version: ${migration.version}`);
        }
        if (names.has(migration.name)) {
            throw new Error(`Duplicate migration name: ${migration.name}`);
        }
        if (migration.version <= previousVersion) {
            throw new Error('Migration entries must be ordered by ascending version');
        }
        versions.add(migration.version);
        names.add(migration.name);
        previousVersion = migration.version;
    }
}
function isVersionRow(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        typeof value.version === 'number' &&
        Number.isSafeInteger(value.version));
}
//# sourceMappingURL=migrate.js.map