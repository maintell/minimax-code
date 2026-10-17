import { withLocalRuntimeDb } from '../db.js';
export class SqliteLegacyMigrationStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async getByLegacySessionId(legacySessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT *
          FROM local_runtime_legacy_migrations
          WHERE legacy_session_id = ?
          LIMIT 1
        `)
                .get(legacySessionId);
            return row ? toMigrationRecord(row) : undefined;
        });
    }
    async getByLocalSessionId(localSessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare(`
          SELECT *
          FROM local_runtime_legacy_migrations
          WHERE local_session_id = ?
          LIMIT 1
        `)
                .get(localSessionId);
            return row ? toMigrationRecord(row) : undefined;
        });
    }
    async listAll() {
        return this.withDb((db) => {
            const rows = db
                .prepare(`
          SELECT *
          FROM local_runtime_legacy_migrations
          ORDER BY migrated_at_ms DESC, legacy_session_id ASC
        `)
                .all();
            return rows.flatMap((row) => {
                const record = toMigrationRecord(row);
                return record ? [record] : [];
            });
        });
    }
    async upsert(record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_legacy_migrations (
          legacy_session_id,
          local_session_id,
          legacy_daemon_session_id,
          legacy_framework_session_id,
          source_runtime,
          status,
          migrated_at_ms,
          source_updated_at_ms,
          source_fingerprint,
          source_schema_fingerprint,
          source_checksum,
          display_checksum,
          pi_history_strategy,
          pi_history_converter_version,
          source_manifest_json,
          source_message_count,
          imported_message_count,
          report_json,
          ledger_imported_at_ms,
          projection_ready_at_ms,
          display_ready_at_ms,
          pi_history_ready_at_ms,
          warnings_json,
          error_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(legacy_session_id) DO UPDATE SET
          local_session_id = excluded.local_session_id,
          legacy_daemon_session_id = excluded.legacy_daemon_session_id,
          legacy_framework_session_id = excluded.legacy_framework_session_id,
          source_runtime = excluded.source_runtime,
          status = excluded.status,
          migrated_at_ms = excluded.migrated_at_ms,
          source_updated_at_ms = excluded.source_updated_at_ms,
          source_fingerprint = excluded.source_fingerprint,
          source_schema_fingerprint = excluded.source_schema_fingerprint,
          source_checksum = excluded.source_checksum,
          display_checksum = excluded.display_checksum,
          pi_history_strategy = excluded.pi_history_strategy,
          pi_history_converter_version = excluded.pi_history_converter_version,
          source_manifest_json = excluded.source_manifest_json,
          source_message_count = excluded.source_message_count,
          imported_message_count = excluded.imported_message_count,
          report_json = excluded.report_json,
          ledger_imported_at_ms = excluded.ledger_imported_at_ms,
          projection_ready_at_ms = excluded.projection_ready_at_ms,
          display_ready_at_ms = excluded.display_ready_at_ms,
          pi_history_ready_at_ms = excluded.pi_history_ready_at_ms,
          warnings_json = excluded.warnings_json,
          error_json = excluded.error_json
      `).run(record.legacySessionId, record.localSessionId, record.legacyDaemonSessionId ?? record.legacySessionId, record.legacyFrameworkSessionId ?? null, record.sourceRuntime, record.status, record.migratedAtMs, record.sourceUpdatedAtMs ?? null, record.sourceFingerprint ?? null, record.sourceSchemaFingerprint ?? null, record.sourceChecksum ?? null, record.displayChecksum ?? null, record.piHistoryStrategy ?? null, record.piHistoryConverterVersion ?? null, record.sourceManifest === undefined ? null : JSON.stringify(record.sourceManifest), record.sourceMessageCount ?? null, record.importedMessageCount ?? null, record.report === undefined ? null : JSON.stringify(record.report), record.ledgerImportedAtMs ?? null, record.projectionReadyAtMs ?? null, record.displayReadyAtMs ?? null, record.piHistoryReadyAtMs ?? null, record.warnings?.length ? JSON.stringify(record.warnings) : null, record.error === undefined ? null : JSON.stringify(record.error));
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function toMigrationRecord(row) {
    if (!row.legacy_session_id ||
        !row.local_session_id ||
        row.source_runtime !== 'opencode' ||
        !isMigrationStatus(row.status) ||
        typeof row.migrated_at_ms !== 'number') {
        return undefined;
    }
    return {
        legacySessionId: row.legacy_session_id,
        localSessionId: row.local_session_id,
        ...(row.legacy_daemon_session_id
            ? { legacyDaemonSessionId: row.legacy_daemon_session_id }
            : {}),
        ...(row.legacy_framework_session_id
            ? { legacyFrameworkSessionId: row.legacy_framework_session_id }
            : {}),
        sourceRuntime: 'opencode',
        status: row.status,
        migratedAtMs: row.migrated_at_ms,
        ...(typeof row.source_updated_at_ms === 'number'
            ? { sourceUpdatedAtMs: row.source_updated_at_ms }
            : {}),
        ...(row.source_fingerprint ? { sourceFingerprint: row.source_fingerprint } : {}),
        ...(row.source_schema_fingerprint
            ? { sourceSchemaFingerprint: row.source_schema_fingerprint }
            : {}),
        ...(row.source_checksum ? { sourceChecksum: row.source_checksum } : {}),
        ...(row.display_checksum ? { displayChecksum: row.display_checksum } : {}),
        ...(row.pi_history_strategy ? { piHistoryStrategy: row.pi_history_strategy } : {}),
        ...(typeof row.pi_history_converter_version === 'number'
            ? { piHistoryConverterVersion: row.pi_history_converter_version }
            : {}),
        ...(row.source_manifest_json ? { sourceManifest: parseJson(row.source_manifest_json) } : {}),
        ...(typeof row.source_message_count === 'number'
            ? { sourceMessageCount: row.source_message_count }
            : {}),
        ...(typeof row.imported_message_count === 'number'
            ? { importedMessageCount: row.imported_message_count }
            : {}),
        ...(row.report_json ? { report: parseJson(row.report_json) } : {}),
        ...(typeof row.ledger_imported_at_ms === 'number'
            ? { ledgerImportedAtMs: row.ledger_imported_at_ms }
            : {}),
        ...(typeof row.projection_ready_at_ms === 'number'
            ? { projectionReadyAtMs: row.projection_ready_at_ms }
            : {}),
        ...(typeof row.display_ready_at_ms === 'number'
            ? { displayReadyAtMs: row.display_ready_at_ms }
            : {}),
        ...(typeof row.pi_history_ready_at_ms === 'number'
            ? { piHistoryReadyAtMs: row.pi_history_ready_at_ms }
            : {}),
        ...(row.warnings_json ? { warnings: parseWarnings(row.warnings_json) } : {}),
        ...(row.error_json ? { error: parseJson(row.error_json) } : {}),
    };
}
function isMigrationStatus(value) {
    return (value === 'discovered' ||
        value === 'metadata' ||
        value === 'migrated' ||
        value === 'failed' ||
        value === 'deleted');
}
function parseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function parseWarnings(value) {
    const parsed = parseJson(value);
    return Array.isArray(parsed)
        ? parsed.filter((item) => typeof item === 'string')
        : [];
}
//# sourceMappingURL=legacy-migration-store.js.map