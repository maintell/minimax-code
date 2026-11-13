import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TICKET_TTL_MS } from './frames.ts';

export interface Binding {
  id: number;
  deviceId: string;
  producerGeneration: number;
  producerVersion: string;
  boundAtMs: number;
  state: 'bound';
}

export function openStore(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS binding (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      producer_generation INTEGER NOT NULL,
      producer_version TEXT NOT NULL,
      bound_at_ms INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ticket (
      hash TEXT PRIMARY KEY,
      binding_id INTEGER NOT NULL,
      issued_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      consumed_at_ms INTEGER
    );
    CREATE TABLE IF NOT EXISTS event_log (
      binding_id INTEGER NOT NULL,
      event_id INTEGER NOT NULL,
      ts_ms INTEGER NOT NULL,
      frame_json TEXT NOT NULL,
      PRIMARY KEY (binding_id, event_id)
    );
    CREATE TABLE IF NOT EXISTS counter (
      binding_id INTEGER PRIMARY KEY,
      event_id INTEGER NOT NULL
    );
  `);

  const toBinding = (row: Record<string, unknown>): Binding => ({
    id: Number(row.id),
    deviceId: String(row.device_id),
    producerGeneration: Number(row.producer_generation),
    producerVersion: String(row.producer_version),
    boundAtMs: Number(row.bound_at_ms),
    state: 'bound',
  });

  return {
    getBinding(bindingId: number): Binding | undefined {
      const row = db.prepare('SELECT * FROM binding WHERE id = ?').get(bindingId);
      return row ? toBinding(row as Record<string, unknown>) : undefined;
    },
    findBindingByDevice(deviceId: string): Binding | undefined {
      const row = db.prepare('SELECT * FROM binding WHERE device_id = ?').get(deviceId);
      return row ? toBinding(row as Record<string, unknown>) : undefined;
    },
    // A console that never sent a device header can still find the one binding
    // this installation serves; with several, only the header identifies which.
    soleBinding(): Binding | undefined {
      const rows = db.prepare('SELECT * FROM binding LIMIT 2').all() as Array<Record<string, unknown>>;
      return rows.length === 1 ? toBinding(rows[0] as Record<string, unknown>) : undefined;
    },
    getOrCreateBinding(deviceId: string, producerVersion: string): Binding {
      const existing = this.findBindingByDevice(deviceId);
      if (existing) {
        db.prepare('UPDATE binding SET producer_version = ? WHERE id = ?').run(producerVersion, existing.id);
        return { ...existing, producerVersion };
      }
      const result = db.prepare(
        'INSERT INTO binding (device_id, producer_generation, producer_version, bound_at_ms, state) VALUES (?, 0, ?, ?, ?)',
      ).run(deviceId, producerVersion, Date.now(), 'bound');
      const id = Number(result.lastInsertRowid);
      // AUTOINCREMENT row ids are never reused, so the rowid survives deletion as a
      // durable monotonic generation; a MAX() over live rows would reset after delete.
      db.prepare('UPDATE binding SET producer_generation = ? WHERE id = ?').run(id, id);
      return this.getBinding(id) as Binding;
    },
    deleteBinding(bindingId: number): void {
      db.prepare('DELETE FROM ticket WHERE binding_id = ?').run(bindingId);
      db.prepare('DELETE FROM event_log WHERE binding_id = ?').run(bindingId);
      db.prepare('DELETE FROM counter WHERE binding_id = ?').run(bindingId);
      db.prepare('DELETE FROM binding WHERE id = ?').run(bindingId);
    },
    mintTicket(bindingId: number, nowMs = Date.now()) {
      const ticket = randomBytes(32).toString('base64url');
      const hash = createHash('sha256').update(ticket).digest('hex');
      const expiresAtMs = nowMs + TICKET_TTL_MS;
      db.prepare('DELETE FROM ticket WHERE binding_id = ? AND consumed_at_ms IS NULL').run(bindingId);
      db.prepare('INSERT INTO ticket (hash, binding_id, issued_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)')
        .run(hash, bindingId, nowMs, expiresAtMs);
      return { ticket, expiresAtMs };
    },
    consumeTicket(ticket: string, bindingId: number, nowMs = Date.now()): boolean {
      const hash = createHash('sha256').update(ticket).digest('hex');
      const row = db.prepare('SELECT * FROM ticket WHERE hash = ?').get(hash) as Record<string, unknown> | undefined;
      if (!row) return false;
      if (Number(row.binding_id) !== bindingId) return false;
      if (row.consumed_at_ms !== null) return false;
      if (Number(row.expires_at_ms) <= nowMs) return false;
      db.prepare('UPDATE ticket SET consumed_at_ms = ? WHERE hash = ?').run(nowMs, hash);
      return true;
    },
    nextEventId(bindingId: number): number {
      db.prepare('INSERT INTO counter (binding_id, event_id) VALUES (?, 0) ON CONFLICT(binding_id) DO NOTHING').run(bindingId);
      db.prepare('UPDATE counter SET event_id = event_id + 1 WHERE binding_id = ?').run(bindingId);
      const row = db.prepare('SELECT event_id FROM counter WHERE binding_id = ?').get(bindingId) as { event_id: number };
      return Number(row.event_id);
    },
    appendEvent(bindingId: number, eventId: number, frame: unknown): void {
      db.prepare('INSERT OR REPLACE INTO event_log (binding_id, event_id, ts_ms, frame_json) VALUES (?, ?, ?, ?)')
        .run(bindingId, eventId, Date.now(), JSON.stringify(frame));
      db.prepare(
        `DELETE FROM event_log WHERE binding_id = ? AND event_id <= (
           SELECT COALESCE(MAX(event_id), 0) - 2000 FROM event_log WHERE binding_id = ?)`,
      ).run(bindingId, bindingId);
    },
    replayAfter(bindingId: number, eventId: number): unknown[] {
      const rows = db.prepare('SELECT frame_json FROM event_log WHERE binding_id = ? AND event_id > ? ORDER BY event_id ASC')
        .all(bindingId, eventId) as Array<{ frame_json: string }>;
      return rows.map((row) => JSON.parse(row.frame_json));
    },
    close(): void {
      db.close();
    },
  };
}

export type Store = ReturnType<typeof openStore>;
