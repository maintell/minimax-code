import { withLocalRuntimeDb } from '../persistence/db.js';
const DEFAULT_LOCK_TTL_MS = 30 * 60 * 1000;
export class SqliteLocalSessionLockStore {
    dataDir;
    nowMs;
    constructor(dataDir, nowMs = () => Date.now()) {
        this.dataDir = dataDir;
        this.nowMs = nowMs;
    }
    async acquire(sessionId, owner, ttlMs = DEFAULT_LOCK_TTL_MS) {
        return this.withDb((db) => {
            const now = this.nowMs();
            const expiresAt = now + ttlMs;
            return runInTransaction(db, () => {
                pruneExpiredOrDeadLocks(db, now);
                const current = db
                    .prepare(`
            SELECT owner_id, owner_kind
            FROM local_runtime_session_locks
            WHERE session_id = ?
          `)
                    .get(sessionId);
                if (!current) {
                    db.prepare(`
            INSERT INTO local_runtime_session_locks (
              session_id,
              owner_id,
              owner_kind,
              acquired_at_ms,
              expires_at_ms
            )
            VALUES (?, ?, ?, ?, ?)
          `).run(sessionId, owner.ownerId, owner.ownerKind, now, expiresAt);
                    return true;
                }
                if (current.owner_id !== owner.ownerId)
                    return false;
                db.prepare(`
          UPDATE local_runtime_session_locks
          SET owner_kind = ?, expires_at_ms = ?
          WHERE session_id = ? AND owner_id = ?
        `).run(owner.ownerKind, expiresAt, sessionId, owner.ownerId);
                return true;
            });
        });
    }
    async release(sessionId, owner) {
        this.withDb((db) => {
            db.prepare(`
        DELETE FROM local_runtime_session_locks
        WHERE session_id = ? AND owner_id = ?
      `).run(sessionId, owner.ownerId);
        });
    }
    async isLockedByOtherOwner(sessionId, owner) {
        return this.withDb((db) => {
            const now = this.nowMs();
            pruneExpiredOrDeadLocks(db, now);
            const current = db
                .prepare(`
          SELECT owner_id, owner_kind
          FROM local_runtime_session_locks
          WHERE session_id = ?
        `)
                .get(sessionId);
            return Boolean(current?.owner_id && current.owner_id !== owner.ownerId);
        });
    }
    withDb(fn) {
        return withLocalRuntimeDb(this.dataDir, fn);
    }
}
function runInTransaction(db, fn) {
    if (db.transaction)
        return db.transaction(fn)();
    return fn();
}
function pruneExpiredOrDeadLocks(db, now) {
    db.prepare('DELETE FROM local_runtime_session_locks WHERE expires_at_ms <= ?').run(now);
    const rows = db
        .prepare(`
      SELECT session_id, owner_id, owner_kind
      FROM local_runtime_session_locks
    `)
        .all();
    for (const row of rows) {
        if (!row.session_id || !isDeadProcessOwner(row.owner_id))
            continue;
        db.prepare('DELETE FROM local_runtime_session_locks WHERE session_id = ? AND owner_id = ?').run(row.session_id, row.owner_id);
    }
}
function isDeadProcessOwner(ownerId) {
    const pid = readOwnerPid(ownerId);
    return pid !== undefined && !isPidAlive(pid);
}
function readOwnerPid(ownerId) {
    const rawPid = ownerId?.split(':')[1];
    if (!rawPid)
        return undefined;
    const pid = Number.parseInt(rawPid, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}
function isPidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=lock-store.js.map