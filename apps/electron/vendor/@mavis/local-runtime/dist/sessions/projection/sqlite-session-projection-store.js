import { withLocalRuntimeDb } from '../../persistence/db.js';
import { SqliteLocalMessageStore, SqliteLocalSessionStore, } from '../../persistence/sqlite-persistence.js';
import { replayLocalSessionLedger, } from './session-projection-replay.js';
export class SqliteLocalSessionProjectionStore {
    dataDir;
    sessionStore;
    messageStore;
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.sessionStore = new SqliteLocalSessionStore(dataDir);
        this.messageStore = new SqliteLocalMessageStore(dataDir);
    }
    async getWatermark(sessionId) {
        return withLocalRuntimeDb(this.dataDir, (db) => readProjectionWatermark(db, sessionId));
    }
    async markWatermark(watermark) {
        withLocalRuntimeDb(this.dataDir, (db) => upsertProjectionWatermark(db, watermark));
    }
    async deleteSession(sessionId) {
        withLocalRuntimeDb(this.dataDir, (db) => {
            db.prepare('DELETE FROM local_runtime_session_projection_watermarks WHERE session_id = ?').run(sessionId);
        });
    }
    async isSessionProjectionStale(sessionId, ledgerStore) {
        const ledgerWatermark = await ledgerStore.getWatermark(sessionId);
        const projectionWatermark = await this.getWatermark(sessionId);
        if (!ledgerWatermark)
            return Boolean(projectionWatermark);
        return (!projectionWatermark ||
            projectionWatermark.lastSeq < ledgerWatermark.lastSeq ||
            projectionWatermark.lastEventId !== ledgerWatermark.lastEventId);
    }
    async repairSessionFromLedger(sessionId, ledgerStore) {
        const events = [];
        for await (const event of ledgerStore.readEvents(sessionId))
            events.push(event);
        const projection = replayLocalSessionLedger(sessionId, events);
        if (!projection.watermark) {
            await this.sessionStore.delete(sessionId);
            await this.messageStore.deleteSession(sessionId);
            await this.deleteSession(sessionId);
            return { projection, repaired: true };
        }
        if (projection.deleted) {
            await this.sessionStore.delete(sessionId);
        }
        else if (projection.record) {
            await this.sessionStore.upsert(projection.record);
        }
        await this.messageStore.setDisplayMessages(sessionId, projection.displayMessages);
        await this.messageStore.setPiHistory(sessionId, projection.piHistory);
        await this.markWatermark(projection.watermark);
        return { projection, repaired: true };
    }
}
function readProjectionWatermark(db, sessionId) {
    const row = db
        .prepare(`
      SELECT last_seq, last_event_id, updated_at_ms
      FROM local_runtime_session_projection_watermarks
      WHERE session_id = ?
    `)
        .get(sessionId);
    if (!row)
        return undefined;
    return {
        sessionId,
        lastSeq: Number(row.last_seq),
        lastEventId: String(row.last_event_id ?? ''),
        updatedAtMs: Number(row.updated_at_ms),
    };
}
function upsertProjectionWatermark(db, watermark) {
    db.prepare(`
    INSERT INTO local_runtime_session_projection_watermarks (
      session_id,
      last_seq,
      last_event_id,
      updated_at_ms
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      last_seq = excluded.last_seq,
      last_event_id = excluded.last_event_id,
      updated_at_ms = excluded.updated_at_ms
  `).run(watermark.sessionId, watermark.lastSeq, watermark.lastEventId, watermark.updatedAtMs);
}
//# sourceMappingURL=sqlite-session-projection-store.js.map