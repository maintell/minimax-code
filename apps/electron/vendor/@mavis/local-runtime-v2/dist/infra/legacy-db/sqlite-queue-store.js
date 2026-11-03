import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { runInTransaction, cloneJson, parseJson, normalizeTimestamp, stableMessageSuffix, } from './sqlite-persistence-values.js';
export class SqliteLocalQueueStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async list(sessionId) {
        return this.withDb((db) => {
            backfillQueueRowsIfNeeded(db, sessionId);
            return listQueueRows(db, sessionId);
        });
    }
    async replaceSession(sessionId, items) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillQueueRowsIfNeededInTransaction(db, sessionId);
                replaceQueueRowsInTransaction(db, sessionId, cloneJson(items));
                markQueueRowsBackfilled(db, sessionId);
            });
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_queues WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_queue_items WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_queue_row_migrations WHERE session_id = ?').run(sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function backfillQueueRowsIfNeeded(db, sessionId) {
    runInTransaction(db, () => backfillQueueRowsIfNeededInTransaction(db, sessionId));
}
function backfillQueueRowsIfNeededInTransaction(db, sessionId) {
    const row = db
        .prepare('SELECT 1 FROM local_runtime_queue_row_migrations WHERE session_id = ? LIMIT 1')
        .get(sessionId);
    if (row)
        return;
    const legacyQueue = readQueueBlob(db, sessionId);
    const currentQueue = listQueueRows(db, sessionId);
    replaceQueueRowsInTransaction(db, sessionId, [...legacyQueue, ...currentQueue]);
    markQueueRowsBackfilled(db, sessionId);
    clearLegacyQueueBlob(db, sessionId);
}
function readQueueBlob(db, sessionId) {
    const row = db
        .prepare('SELECT items_json FROM local_runtime_queues WHERE session_id = ?')
        .get(sessionId);
    return parseJson(row?.items_json) ?? [];
}
function listQueueRows(db, sessionId) {
    const rows = db
        .prepare(`
      SELECT data_json
      FROM local_runtime_queue_items
      WHERE session_id = ?
      ORDER BY id ASC
    `)
        .all(sessionId);
    return rows.flatMap(readQueueItemRow);
}
function replaceQueueRowsInTransaction(db, sessionId, items) {
    db.prepare('DELETE FROM local_runtime_queue_items WHERE session_id = ?').run(sessionId);
    for (const item of items) {
        insertQueueRow(db, sessionId, item);
    }
}
function insertQueueRow(db, sessionId, item) {
    const normalized = normalizeQueueItem(item);
    db.prepare(`
    INSERT INTO local_runtime_queue_items (
      session_id,
      item_id,
      status,
      created_at_ms,
      data_json
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, item_id) DO UPDATE SET
      status = excluded.status,
      created_at_ms = excluded.created_at_ms,
      data_json = excluded.data_json
  `).run(sessionId, normalized.itemId, normalized.status, normalized.createdAtMs, normalized.dataJson);
}
function markQueueRowsBackfilled(db, sessionId) {
    db.prepare(`
    INSERT INTO local_runtime_queue_row_migrations (session_id, queue_rows_backfilled_at_ms)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      queue_rows_backfilled_at_ms = excluded.queue_rows_backfilled_at_ms
  `).run(sessionId, Date.now());
}
function clearLegacyQueueBlob(db, sessionId) {
    db.prepare('DELETE FROM local_runtime_queues WHERE session_id = ?').run(sessionId);
}
function normalizeQueueItem(item) {
    const record = item;
    const itemId = typeof record.itemId === 'string' && record.itemId
        ? record.itemId
        : `queue-${normalizeTimestamp(record.createdAt)}-${stableMessageSuffix(record)}`;
    const createdAtMs = normalizeTimestamp(record.createdAt);
    const normalized = { ...record, itemId, createdAt: createdAtMs };
    return {
        itemId,
        status: typeof record.status === 'string' ? record.status : null,
        createdAtMs,
        dataJson: JSON.stringify(normalized),
    };
}
function readQueueItemRow(row) {
    const parsed = parseJson(row.data_json);
    return parsed ? [parsed] : [];
}
//# sourceMappingURL=sqlite-queue-store.js.map