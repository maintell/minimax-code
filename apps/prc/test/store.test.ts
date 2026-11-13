import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.ts';

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-store-'));
  return openStore(path.join(dir, 'prc.sqlite'));
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
  assert.equal(store.consumeTicket(ticket, other.id, 2_000), false);
  assert.equal(store.consumeTicket(ticket, binding.id, 2_000), true);
  assert.equal(store.consumeTicket(ticket, binding.id, 2_000), false);

  const stale = store.mintTicket(binding.id, 1_000);
  assert.ok(stale.expiresAtMs > expiresAtMs);
  assert.equal(store.consumeTicket(stale.ticket, binding.id, 1_000 + 61_000), false);
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
