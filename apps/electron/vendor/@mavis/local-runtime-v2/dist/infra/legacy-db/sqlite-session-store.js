import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { applyLocalSessionListOptions } from '../conversation/record-list-options.js';
import { parseJson } from './sqlite-persistence-values.js';
export class SqliteLocalSessionStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async get(sessionId) {
        return this.withDb((db) => {
            const row = db
                .prepare('SELECT record_json FROM local_runtime_sessions WHERE session_id = ?')
                .get(sessionId);
            return parseJson(row?.record_json);
        });
    }
    async upsert(record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_sessions (session_id, record_json, updated_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          record_json = excluded.record_json,
          updated_at_ms = excluded.updated_at_ms
      `).run(record.sessionId, JSON.stringify(record), record.updatedAtMs);
        });
    }
    async delete(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_sessions WHERE session_id = ?').run(sessionId);
        });
    }
    async list(options) {
        return this.withDb((db) => {
            const scanLimit = normalizeScanLimit(options?.scanLimit);
            // The DESC recency order walks idx_local_runtime_sessions_updated_at
            // backwards, so a scanLimit stops the scan after N index entries
            // instead of loading and parsing the whole table.
            const rows = scanLimit !== undefined
                ? db
                    .prepare('SELECT record_json FROM local_runtime_sessions ORDER BY updated_at_ms DESC LIMIT ?')
                    .all(scanLimit)
                : db
                    .prepare('SELECT record_json FROM local_runtime_sessions ORDER BY updated_at_ms DESC')
                    .all();
            const records = rows.flatMap((row) => {
                const record = parseJson(row.record_json);
                return record ? [record] : [];
            });
            return applyLocalSessionListOptions(records, options);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function normalizeScanLimit(value) {
    if (value === undefined || !Number.isFinite(value))
        return undefined;
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : undefined;
}
//# sourceMappingURL=sqlite-session-store.js.map