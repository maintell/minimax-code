import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveV2DirectoryContract } from '@mavis/shared/local-runtime-paths';
/**
 * Persistent migration quarantine list (`superseded` entries).
 *
 * A migration that still fails after the same-boot retry is recorded here and
 * never automatically re-attempted on later boots: once the user keeps using
 * the degraded runtime the database drifts, and replaying the old script
 * would be a wrong-run against user data. Repairs land as explicit new
 * migration versions. The version table stays honest — quarantined versions
 * are never written into `local_runtime_v2_schema_migrations`.
 * See `.harness/docs/adr/local-runtime-migration-fault-tolerance.md`.
 */
const MIGRATION_QUARANTINE_FILE = 'migration-quarantine.json';
const MAX_RECORDED_ERROR_LENGTH = 500;
/**
 * Reads the persisted quarantine list. A missing, unreadable, or corrupted
 * file is treated as an empty list: quarantine is a safety net, not a source
 * of truth worth failing startup over, and the next quarantine write rebuilds
 * it.
 */
export function readMigrationQuarantine(dataDir) {
    let raw;
    try {
        raw = readFileSync(quarantineFilePath(dataDir), 'utf8');
    }
    catch {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return [];
        if (parsed.schemaVersion !== 1)
            return [];
        const entries = parsed.entries;
        if (!Array.isArray(entries))
            return [];
        return entries.filter(isQuarantinedMigration);
    }
    catch {
        return [];
    }
}
/**
 * Upserts newly superseded migrations into the persisted list and returns the
 * updated list. Persisting is best-effort: a write failure only means the
 * quarantine is retried on the next boot, so it must never block startup.
 */
export function quarantineMigrations(dataDir, candidates, nowMs = Date.now()) {
    const byVersion = new Map();
    for (const entry of readMigrationQuarantine(dataDir))
        byVersion.set(entry.version, entry);
    for (const candidate of candidates) {
        const existing = byVersion.get(candidate.version);
        byVersion.set(candidate.version, {
            version: candidate.version,
            name: candidate.name,
            firstFailedAtMs: existing?.firstFailedAtMs ?? nowMs,
            supersededAtMs: nowMs,
            lastError: describeError(candidate.error),
        });
    }
    const entries = [...byVersion.values()].sort((left, right) => left.version - right.version);
    writeQuarantineFile(dataDir, { schemaVersion: 1, entries });
    return entries;
}
function writeQuarantineFile(dataDir, file) {
    try {
        const contract = resolveV2DirectoryContract(dataDir);
        mkdirSync(contract.migration, { recursive: true });
        const finalPath = join(contract.migration, MIGRATION_QUARANTINE_FILE);
        // Write-then-rename keeps a crash from leaving a half-written list that a
        // later boot would read as empty and use to re-run a quarantined script.
        const temporaryPath = `${finalPath}.tmp`;
        writeFileSync(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
        renameSync(temporaryPath, finalPath);
    }
    catch {
        // Best-effort persistence; see quarantineMigrations.
    }
}
function quarantineFilePath(dataDir) {
    return join(resolveV2DirectoryContract(dataDir).migration, MIGRATION_QUARANTINE_FILE);
}
function isQuarantinedMigration(value) {
    if (!value || typeof value !== 'object')
        return false;
    const entry = value;
    return (typeof entry.version === 'number' &&
        Number.isSafeInteger(entry.version) &&
        entry.version > 0 &&
        typeof entry.name === 'string' &&
        typeof entry.firstFailedAtMs === 'number' &&
        typeof entry.supersededAtMs === 'number' &&
        typeof entry.lastError === 'string');
}
function describeError(error) {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown error');
    return text.slice(0, MAX_RECORDED_ERROR_LENGTH);
}
//# sourceMappingURL=migration-quarantine.js.map