import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.ts';

function freshStoreFile() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-store-'));
  const file = path.join(dir, 'prc.sqlite');
  return { file, store: openStore(file) };
}

function freshStore() {
  return freshStoreFile().store;
}

test('a device gets one binding and a new generation on recreate', () => {
  const store = freshStore();
  const first = store.getOrCreateBinding('dev-1', '3.1.14');
  assert.equal(store.getOrCreateBinding('dev-1', '3.1.14').id, first.id);
  store.deleteBinding(first.id);
  const second = store.getOrCreateBinding('dev-1', '3.1.14');
  assert.notEqual(second.id, first.id);
  assert.ok(second.producerGeneration > first.producerGeneration);
});

test('tickets are single use, expire, and are binding scoped', () => {
  const store = freshStore();
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const other = store.getOrCreateBinding('dev-2', '3.1.14');
  const { ticket, expiresAtMs } = store.mintTicket(binding.id, 1_000);
  assert.equal(expiresAtMs, 61_000);
  assert.equal(store.consumeTicket(ticket, other.id, 2_000), false);
  assert.equal(store.consumeTicket(ticket, binding.id, 2_000), true);
  assert.equal(store.consumeTicket(ticket, binding.id, 2_000), false);

  const later = store.mintTicket(binding.id, 1_001);
  assert.equal(later.expiresAtMs, 61_001);
  assert.ok(later.expiresAtMs > expiresAtMs);
});

test('a ticket is consumable until its expiry instant and dead at it', () => {
  const store = freshStore();
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');

  const beforeEdge = store.mintTicket(binding.id, 1_000);
  assert.equal(beforeEdge.expiresAtMs, 61_000);
  assert.equal(store.consumeTicket(beforeEdge.ticket, binding.id, 60_999), true);

  const atEdge = store.mintTicket(binding.id, 1_000);
  assert.equal(atEdge.expiresAtMs, 61_000);
  assert.equal(store.consumeTicket(atEdge.ticket, binding.id, 61_000), false);
});

test('event ids are monotonic per binding and replay is ordered', () => {
  const store = freshStore();
  const a = store.getOrCreateBinding('dev-1', '3.1.14');
  const b = store.getOrCreateBinding('dev-2', '3.1.14');
  assert.equal(store.nextEventId(a.id), 1);
  assert.equal(store.nextEventId(a.id), 2);
  assert.equal(store.nextEventId(b.id), 1);
  store.appendEvent(a.id, 1, { type: 'evt.a' });
  store.appendEvent(a.id, 2, { type: 'evt.b' });
  const replayed = store.replayAfter(a.id, 1).map((frame) => (frame as { type: string }).type);
  assert.deepEqual(replayed, ['evt.b']);
});

test('the event log keeps only the newest 2000 frames per binding', () => {
  // In-memory: this exercises the trim SQL, and 2 005 file-backed appends cost
  // thousands of WAL fsyncs. Durability has its own reopen test below.
  const store = openStore(':memory:');
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  for (let eventId = 1; eventId <= 2_005; eventId += 1) {
    store.appendEvent(binding.id, eventId, { type: 'evt.trim', event_id: eventId });
  }
  const replayed = store.replayAfter(binding.id, 0) as Array<{ event_id: number }>;
  assert.equal(replayed.length, 2_000);
  assert.equal(replayed[0].event_id, 6);
  assert.equal(replayed.at(-1)?.event_id, 2_005);
  assert.deepEqual(store.replayAfter(binding.id, 2_004).map((frame) => (frame as { event_id: number }).event_id), [2_005]);
});

test('event ids and replay survive close and reopen', () => {
  const { file, store } = freshStoreFile();
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  store.appendEvent(binding.id, store.nextEventId(binding.id), { type: 'evt.first' });
  store.appendEvent(binding.id, store.nextEventId(binding.id), { type: 'evt.second' });
  store.close();

  const reopened = openStore(file);
  assert.equal(reopened.findBindingByDevice('dev-1')?.id, binding.id);
  assert.equal(reopened.nextEventId(binding.id), 3);
  assert.deepEqual(reopened.replayAfter(binding.id, 2), []);
  reopened.close();
});

test('tickets are stored hashed and never as plaintext on disk', () => {
  const { file, store } = freshStoreFile();
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const { ticket } = store.mintTicket(binding.id, 1_000);
  store.close();

  const stored = readFileSync(file);
  const hash = createHash('sha256').update(ticket).digest('hex');
  assert.equal(stored.includes(Buffer.from(ticket, 'utf8')), false);
  assert.equal(stored.includes(Buffer.from(hash, 'utf8')), true);
});
