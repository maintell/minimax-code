import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { advanceSessionAssetIndexStateInTransaction, clearSessionAssetRowsInTransaction, deleteSessionAssetDataInTransaction, deleteSessionAssetRowsForMessagesInTransaction, indexDisplayMessageAssetsInTransaction, initSessionAssetIndexStateInTransaction, markSessionAssetIndexReadyInTransaction, rebuildSessionAssetsInTransaction, } from './session-assets-session-asset-index.js';
import { runInTransaction, cloneJson, parseJson, normalizeTimestamp, stableMessageSuffix, } from './sqlite-persistence-values.js';
export class SqliteLocalMessageStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async initSession(sessionId) {
        // Seed a ready/empty asset index state so subsequent hooked writes keep
        // the session asset index current without a lazy full scan.
        this.withDb((db) => {
            initSessionAssetIndexStateInTransaction(db, sessionId);
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare('DELETE FROM local_runtime_messages WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_message_row_migrations WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_pi_history_rows WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM local_runtime_pi_history_row_migrations WHERE session_id = ?').run(sessionId);
            deleteSessionAssetDataInTransaction(db, sessionId);
        });
    }
    async getDisplayMessages(sessionId) {
        return (await this.listDisplayMessages(sessionId)).messages;
    }
    async listDisplayMessages(sessionId, opts) {
        return this.withDb((db) => {
            backfillDisplayMessageRowsIfNeeded(db, sessionId);
            return listDisplayMessageRows(db, sessionId, opts);
        });
    }
    async listRecentDisplayMessages(sessionId, opts) {
        return this.withDb((db) => {
            backfillDisplayMessageRowsIfNeeded(db, sessionId);
            return listRecentDisplayMessageRows(db, sessionId, opts);
        });
    }
    async setDisplayMessages(sessionId, messages) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                replaceDisplayMessageRowsInTransaction(db, sessionId, cloneJson(messages));
                markDisplayMessageRowsBackfilled(db, sessionId);
                clearLegacyDisplayMessagesBlob(db, sessionId);
                rebuildSessionAssetsInTransaction(db, sessionId);
            });
        });
    }
    async upsertDisplayMessage(sessionId, message) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);
                const normalized = upsertDisplayMessageRow(db, sessionId, cloneJson(message));
                indexDisplayMessageAssetsInTransaction(db, sessionId, {
                    msgId: normalized.msgId,
                    role: normalized.role,
                    createdAtMs: normalized.createdAtMs,
                    msgContent: typeof message.msg_content === 'string' ? message.msg_content : '',
                });
                advanceSessionAssetIndexStateInTransaction(db, sessionId);
            });
        });
    }
    async appendDisplayMessages(sessionId, messages, opts) {
        if (messages.length === 0) {
            // A `replaceExisting` first batch that happens to be empty must still
            // clear the session so the streamed import can produce an empty result
            // without leaking stale rows.
            if (opts?.replaceExisting) {
                this.withDb((db) => {
                    runInTransaction(db, () => {
                        replaceDisplayMessageRowsInTransaction(db, sessionId, []);
                        markDisplayMessageRowsBackfilled(db, sessionId);
                        clearLegacyDisplayMessagesBlob(db, sessionId);
                        rebuildSessionAssetsInTransaction(db, sessionId);
                    });
                });
            }
            return;
        }
        this.withDb((db) => {
            runInTransaction(db, () => {
                const replaceExisting = opts?.replaceExisting === true;
                if (replaceExisting) {
                    db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(sessionId);
                    clearSessionAssetRowsInTransaction(db, sessionId);
                }
                else {
                    backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);
                }
                for (const message of messages) {
                    const normalized = upsertDisplayMessageRow(db, sessionId, message);
                    indexDisplayMessageAssetsInTransaction(db, sessionId, {
                        msgId: normalized.msgId,
                        role: normalized.role,
                        createdAtMs: normalized.createdAtMs,
                        msgContent: typeof message.msg_content === 'string' ? message.msg_content : '',
                    });
                }
                // Match `setDisplayMessages` bookkeeping so a streamed import ends in the
                // exact same persisted state as a single full write: the rows are
                // authoritative (backfilled), the legacy display blob is dropped, and
                // the derived session-asset index is advanced. These are idempotent, so
                // running them on every batch keeps each committed batch self-consistent
                // (a crash between batches leaves a valid prefix, not a half-written
                // transaction).
                markDisplayMessageRowsBackfilled(db, sessionId);
                clearLegacyDisplayMessagesBlob(db, sessionId);
                if (replaceExisting) {
                    markSessionAssetIndexReadyInTransaction(db, sessionId);
                }
                else {
                    advanceSessionAssetIndexStateInTransaction(db, sessionId);
                }
            });
        });
    }
    async deleteDisplayMessagesByIds(sessionId, msgIds) {
        if (msgIds.length === 0)
            return;
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId);
                const stmt = db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ? AND msg_id = ?');
                for (const msgId of msgIds) {
                    stmt.run(sessionId, msgId);
                }
                deleteSessionAssetRowsForMessagesInTransaction(db, sessionId, msgIds);
            });
        });
    }
    async getPiHistory(sessionId) {
        return this.withDb((db) => {
            backfillPiHistoryRowsIfNeeded(db, sessionId);
            return listPiHistoryRows(db, sessionId);
        });
    }
    async setPiHistory(sessionId, messages) {
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillPiHistoryRowsIfNeededInTransaction(db, sessionId);
                replacePiHistoryRowsInTransaction(db, sessionId, cloneJson(messages));
                markPiHistoryRowsBackfilled(db, sessionId);
                clearLegacyPiHistoryBlob(db, sessionId);
            });
        });
    }
    async appendPiHistory(sessionId, messages) {
        if (messages.length === 0)
            return;
        this.withDb((db) => {
            runInTransaction(db, () => {
                backfillPiHistoryRowsIfNeededInTransaction(db, sessionId);
                appendPiHistoryRows(db, sessionId, cloneJson(messages));
            });
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
// A single JS string cannot exceed V8's `String::kMaxLength` (0x1fffffe8,
// ~512MB). A legacy `local_runtime_messages` blob for a very heavy session
// (many tool outputs / image processing / PPT intermediate dumps) can grow
// past that ceiling. When better-sqlite3 materializes such a column value it
// throws `RangeError: Cannot create a string longer than 0x1fffffe8`. That
// RangeError previously propagated out of `listDisplayMessages` / `getPiHistory`
// (both re-run the legacy blob → rows backfill on every read until the
// migration marker exists), turning one oversized session into a permanent
// history-load 500. We now read each legacy blob column in isolation and treat
// an oversized/unreadable blob as unrecoverable: the caller drops the legacy
// merge, keeps whatever row-based data exists, and still marks the backfill
// done + clears the blob so subsequent reads never re-trip the ceiling.
function isStringLengthOverflowError(err) {
    return err instanceof RangeError && /string longer than/i.test(err.message);
}
function readLegacyBlobColumn(db, sessionId, column) {
    try {
        const row = db
            .prepare(`
      SELECT ${column} AS blob
      FROM local_runtime_messages
      WHERE session_id = ?
    `)
            .get(sessionId);
        return { messages: parseJson(row?.blob) ?? [], unrecoverable: false };
    }
    catch (err) {
        if (isStringLengthOverflowError(err)) {
            return { messages: [], unrecoverable: true };
        }
        throw err;
    }
}
function readLegacyDisplayMessagesBlob(db, sessionId) {
    return readLegacyBlobColumn(db, sessionId, 'display_messages_json');
}
function readLegacyPiHistoryBlob(db, sessionId) {
    return readLegacyBlobColumn(db, sessionId, 'pi_history_json');
}
function backfillDisplayMessageRowsIfNeeded(db, sessionId) {
    runInTransaction(db, () => backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId));
}
// Exported for the session asset store: lazy indexing must scan real message
// rows, so the legacy blob → rows backfill has to run inside its transaction.
export function backfillDisplayMessageRowsIfNeededInTransaction(db, sessionId) {
    const row = db
        .prepare('SELECT 1 FROM local_runtime_message_row_migrations WHERE session_id = ? LIMIT 1')
        .get(sessionId);
    if (row)
        return;
    const legacy = readLegacyDisplayMessagesBlob(db, sessionId);
    const currentRows = listAllDisplayMessageRows(db, sessionId);
    // Oversized/unreadable legacy blob: keep only the row-based history so the
    // session stays loadable instead of throwing a RangeError on every read.
    replaceDisplayMessageRowsInTransaction(db, sessionId, legacy.unrecoverable
        ? currentRows.flatMap(readDisplayMessageRow)
        : mergeBackfilledDisplayMessages(legacy.messages, currentRows));
    markDisplayMessageRowsBackfilled(db, sessionId);
    clearLegacyDisplayMessagesBlob(db, sessionId);
}
function listDisplayMessageRows(db, sessionId, opts) {
    const limit = normalizeMessageLimit(opts?.limit);
    if (limit <= 0) {
        const rows = opts?.before
            ? selectDisplayMessageRowsBefore(db, sessionId, opts.before)
            : listAllDisplayMessageRows(db, sessionId);
        return { messages: rows.flatMap(readDisplayMessageRow), hasMore: false };
    }
    const before = opts?.before;
    let rows;
    if (before) {
        const cursorRow = db
            .prepare('SELECT id FROM local_runtime_message_rows WHERE session_id = ? AND msg_id = ?')
            .get(sessionId, before);
        rows = cursorRow?.id
            ? db
                .prepare(`
            SELECT data_json
            FROM local_runtime_message_rows
            WHERE session_id = ? AND id < ?
            ORDER BY id DESC
            LIMIT ?
          `)
                .all(sessionId, cursorRow.id, limit + 1)
            : selectLatestDisplayMessageRows(db, sessionId, limit + 1);
    }
    else {
        rows = selectLatestDisplayMessageRows(db, sessionId, limit + 1);
    }
    const hasMore = rows.length > limit;
    if (hasMore)
        rows.pop();
    rows.reverse();
    const messages = rows.flatMap(readDisplayMessageRow);
    return {
        messages,
        hasMore,
        ...(hasMore && messages[0]?.msg_id ? { nextCursor: messages[0].msg_id } : {}),
    };
}
// Mirrors the daemon SqliteMessageStore.getRecent statements: the role filter
// and the synthetic `<permission-response>` exclusion live in the SQL WHERE
// clause so `limit` counts matching rows, then rows come back chronological.
function listRecentDisplayMessageRows(db, sessionId, opts) {
    if (!Number.isFinite(opts.limit) || opts.limit <= 0)
        return [];
    const limit = Math.floor(opts.limit);
    const where = ['session_id = ?'];
    const params = [sessionId];
    if (opts.role) {
        where.push('role = ?');
        params.push(opts.role);
    }
    if (opts.excludePermissionResponses) {
        where.push('data_json NOT LIKE ?');
        params.push('%<permission-response>%');
    }
    const rows = db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT ?
    `)
        .all(...params, limit);
    rows.reverse();
    return rows.flatMap(readDisplayMessageRow);
}
function listAllDisplayMessageRows(db, sessionId) {
    return db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE session_id = ?
      ORDER BY id ASC
    `)
        .all(sessionId);
}
function selectDisplayMessageRowsBefore(db, sessionId, before) {
    const cursorRow = db
        .prepare('SELECT id FROM local_runtime_message_rows WHERE session_id = ? AND msg_id = ?')
        .get(sessionId, before);
    if (!cursorRow?.id)
        return listAllDisplayMessageRows(db, sessionId);
    return db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE session_id = ? AND id < ?
      ORDER BY id ASC
    `)
        .all(sessionId, cursorRow.id);
}
function selectLatestDisplayMessageRows(db, sessionId, limit) {
    return db
        .prepare(`
      SELECT data_json
      FROM local_runtime_message_rows
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
        .all(sessionId, limit);
}
function replaceDisplayMessageRowsInTransaction(db, sessionId, messages) {
    db.prepare('DELETE FROM local_runtime_message_rows WHERE session_id = ?').run(sessionId);
    for (const message of messages) {
        upsertDisplayMessageRow(db, sessionId, message);
    }
}
function mergeBackfilledDisplayMessages(legacyMessages, currentRows) {
    const currentMessages = currentRows.flatMap(readDisplayMessageRow);
    if (legacyMessages.length === 0)
        return currentMessages;
    const currentById = indexDisplayMessages(currentMessages);
    const merged = [];
    for (const legacyMessage of legacyMessages) {
        const msgId = legacyMessage.msg_id;
        merged.push(takeCurrentDisplayMessage(currentById, msgId) ?? legacyMessage);
    }
    for (const currentMessage of currentMessages) {
        const msgId = currentMessage.msg_id;
        if (typeof msgId === 'string' && msgId && !currentById.has(msgId))
            continue;
        merged.push(currentMessage);
        if (typeof msgId === 'string' && msgId)
            currentById.delete(msgId);
    }
    return merged;
}
function takeCurrentDisplayMessage(indexed, msgId) {
    if (typeof msgId !== 'string')
        return undefined;
    const message = indexed.get(msgId);
    if (message)
        indexed.delete(msgId);
    return message;
}
function indexDisplayMessages(messages) {
    const indexed = new Map();
    for (const message of messages) {
        const msgId = message.msg_id;
        if (typeof msgId === 'string' && msgId)
            indexed.set(msgId, message);
    }
    return indexed;
}
function markDisplayMessageRowsBackfilled(db, sessionId) {
    db.prepare(`
    INSERT INTO local_runtime_message_row_migrations (session_id, display_rows_backfilled_at_ms)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      display_rows_backfilled_at_ms = excluded.display_rows_backfilled_at_ms
  `).run(sessionId, Date.now());
}
function backfillPiHistoryRowsIfNeeded(db, sessionId) {
    runInTransaction(db, () => backfillPiHistoryRowsIfNeededInTransaction(db, sessionId));
}
// Exported (mirrors `backfillDisplayMessageRowsIfNeededInTransaction`) so the
// oversized-legacy-blob degradation path can be unit-tested with an injected
// database that reproduces the V8 string-length RangeError.
/** @internal Exported only for focused tests. */
export function backfillPiHistoryRowsIfNeededInTransaction(db, sessionId) {
    const row = db
        .prepare('SELECT 1 FROM local_runtime_pi_history_row_migrations WHERE session_id = ? LIMIT 1')
        .get(sessionId);
    if (row)
        return;
    const legacy = readLegacyPiHistoryBlob(db, sessionId);
    const currentHistory = listPiHistoryRows(db, sessionId);
    // Oversized/unreadable legacy pi-history blob: keep only the row-based
    // history so pi-history loads (resume, POST /message) stay non-fatal.
    replacePiHistoryRowsInTransaction(db, sessionId, legacy.unrecoverable ? currentHistory : [...legacy.messages, ...currentHistory]);
    markPiHistoryRowsBackfilled(db, sessionId);
    clearLegacyPiHistoryBlob(db, sessionId);
}
function listPiHistoryRows(db, sessionId) {
    const rows = db
        .prepare(`
      SELECT data_json
      FROM local_runtime_pi_history_rows
      WHERE session_id = ?
      ORDER BY id ASC
    `)
        .all(sessionId);
    return rows.flatMap(readPiHistoryRow);
}
function replacePiHistoryRowsInTransaction(db, sessionId, messages) {
    db.prepare('DELETE FROM local_runtime_pi_history_rows WHERE session_id = ?').run(sessionId);
    appendPiHistoryRows(db, sessionId, messages);
}
function appendPiHistoryRows(db, sessionId, messages) {
    for (const message of messages) {
        appendPiHistoryRow(db, sessionId, message);
    }
}
function appendPiHistoryRow(db, sessionId, message) {
    const normalized = normalizePiHistoryMessage(message);
    db.prepare(`
    INSERT INTO local_runtime_pi_history_rows (
      session_id,
      role,
      created_at_ms,
      data_json
    ) VALUES (?, ?, ?, ?)
  `).run(sessionId, normalized.role, normalized.createdAtMs, normalized.dataJson);
}
function markPiHistoryRowsBackfilled(db, sessionId) {
    db.prepare(`
    INSERT INTO local_runtime_pi_history_row_migrations (session_id, history_rows_backfilled_at_ms)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      history_rows_backfilled_at_ms = excluded.history_rows_backfilled_at_ms
  `).run(sessionId, Date.now());
}
function clearLegacyDisplayMessagesBlob(db, sessionId) {
    db.prepare(`
    UPDATE local_runtime_messages
    SET display_messages_json = '[]'
    WHERE session_id = ?
  `).run(sessionId);
    deleteEmptyLegacyMessageBlobRow(db, sessionId);
}
function clearLegacyPiHistoryBlob(db, sessionId) {
    db.prepare(`
    UPDATE local_runtime_messages
    SET pi_history_json = '[]'
    WHERE session_id = ?
  `).run(sessionId);
    deleteEmptyLegacyMessageBlobRow(db, sessionId);
}
function deleteEmptyLegacyMessageBlobRow(db, sessionId) {
    db.prepare(`
    DELETE FROM local_runtime_messages
    WHERE session_id = ?
      AND display_messages_json = '[]'
      AND pi_history_json = '[]'
  `).run(sessionId);
}
function upsertDisplayMessageRow(db, sessionId, message) {
    const normalized = normalizeDisplayMessage(message);
    db.prepare(`
    INSERT INTO local_runtime_message_rows (
      session_id,
      msg_id,
      role,
      turn_id,
      created_at_ms,
      data_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id, msg_id) DO UPDATE SET
      role = excluded.role,
      turn_id = excluded.turn_id,
      created_at_ms = excluded.created_at_ms,
      data_json = excluded.data_json
  `).run(sessionId, normalized.msgId, normalized.role, normalized.turnId, normalized.createdAtMs, normalized.dataJson);
    return normalized;
}
function normalizeDisplayMessage(message) {
    const record = message;
    const createdAtMs = normalizeTimestamp(record.timestamp ?? record.created_at);
    const msgId = String(record.msg_id || `msg-${createdAtMs}-${stableMessageSuffix(record)}`);
    const dataJson = JSON.stringify({ ...record, msg_id: msgId });
    return {
        msgId,
        role: typeof record.role === 'string' ? record.role : null,
        turnId: displayMessageTurnId(record),
        createdAtMs,
        dataJson,
    };
}
function displayMessageTurnId(record) {
    if (typeof record.turnId === 'string')
        return record.turnId;
    return typeof record.meta?.turnId === 'string' ? record.meta.turnId : null;
}
function readDisplayMessageRow(row) {
    const parsed = parseJson(row.data_json);
    return parsed ? [parsed] : [];
}
function normalizePiHistoryMessage(message) {
    const record = message;
    return {
        role: typeof record.role === 'string' ? record.role : null,
        createdAtMs: normalizeTimestamp(record.timestamp ?? record.created_at),
        dataJson: JSON.stringify(record),
    };
}
function readPiHistoryRow(row) {
    const parsed = parseJson(row.data_json);
    return parsed ? [parsed] : [];
}
function normalizeMessageLimit(limit) {
    if (!Number.isFinite(limit ?? 0))
        return 0;
    return Math.max(0, Math.floor(limit ?? 0));
}
//# sourceMappingURL=sqlite-message-store.js.map