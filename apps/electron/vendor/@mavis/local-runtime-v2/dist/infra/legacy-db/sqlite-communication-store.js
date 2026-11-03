import { withLocalRuntimeDb } from './db.js';
import {} from './database-contracts.js';
import { normalizePositiveInteger, numericOrZero } from './sqlite-persistence-values.js';
export class SqliteLocalCommunicationMessageStore {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async append(record) {
        this.withDb((db) => {
            db.prepare(`
        INSERT INTO local_runtime_communication_messages (
          message_id, from_session, to_session, command, content, status, error, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(message_id) DO UPDATE SET
          from_session = excluded.from_session,
          to_session = excluded.to_session,
          command = excluded.command,
          content = excluded.content,
          status = excluded.status,
          error = excluded.error,
          created_at_ms = excluded.created_at_ms
      `).run(record.messageId, record.fromSession, record.toSession, record.command, record.content, record.status, record.error ?? null, record.createdAtMs);
        });
    }
    async list(opts) {
        return this.withDb((db) => {
            const where = ['1 = 1'];
            const params = [];
            if (opts?.fromSession) {
                where.push('from_session = ?');
                params.push(opts.fromSession);
            }
            if (opts?.toSession) {
                where.push('to_session = ?');
                params.push(opts.toSession);
            }
            if (opts?.status) {
                where.push('status = ?');
                params.push(opts.status);
            }
            const limit = normalizePositiveInteger(opts?.limit) ?? 50;
            const rows = db
                .prepare(`
          SELECT * FROM local_runtime_communication_messages
          WHERE ${where.join(' AND ')}
          ORDER BY created_at_ms DESC, message_id DESC
          LIMIT ?
        `)
                .all(...params, limit);
            return rows.flatMap(readCommunicationMessageRow);
        });
    }
    async deleteSession(sessionId) {
        this.withDb((db) => {
            db.prepare(`
        DELETE FROM local_runtime_communication_messages
        WHERE from_session = ? OR to_session = ?
      `).run(sessionId, sessionId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function readCommunicationMessageRow(row) {
    const messageId = row.message_id;
    const fromSession = row.from_session;
    const toSession = row.to_session;
    const command = row.command;
    const status = row.status;
    if (!messageId ||
        !fromSession ||
        !toSession ||
        !command ||
        (status !== 'delivered' && status !== 'failed')) {
        return [];
    }
    return [
        {
            messageId,
            fromSession,
            toSession,
            command,
            content: row.content ?? '',
            status,
            ...(row.error ? { error: row.error } : {}),
            createdAtMs: numericOrZero(row.created_at_ms),
        },
    ];
}
//# sourceMappingURL=sqlite-communication-store.js.map