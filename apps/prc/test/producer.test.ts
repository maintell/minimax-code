import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.ts';
import { ProducerSocket } from '../src/producer.ts';

class FakeWs extends EventEmitter {
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  send(text: string) { this.sent.push(text); }
  close(code?: number, reason?: string) { this.closed.push({ code, reason }); }
  emitFrame(frame: unknown) { this.emit('message', JSON.stringify(frame)); }
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-producer-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const ws = new FakeWs();
  const frames: unknown[] = [];
  const producer = new ProducerSocket({
    socket: ws as never,
    bindingId: binding.id,
    store,
    logger: { info() {}, warn() {}, error() {} },
    onFrame: (frame) => frames.push(frame),
    onClose: () => {},
  });
  return { store, binding, ws, producer, frames };
}

test('hello is sent before anything else and carries the frame cap', () => {
  const { ws, producer } = setup();
  producer.start();
  const hello = JSON.parse(ws.sent[0] ?? '{}');
  assert.equal(hello.type, 'ctrl.hello');
  assert.ok(hello.payload.connection_id);
  assert.equal(hello.payload.max_message_bytes, 128 * 1024 * 1024);
});

test('auth.complete marks the socket ready and pings are answered', () => {
  const { ws, producer } = setup();
  producer.start();
  ws.emitFrame({ v: 1, id: 'a', ts: 1, type: 'ctrl.auth.complete', payload: {} });
  assert.equal(producer.isAuthed(), true);
  ws.emitFrame({ v: 1, id: 'b', ts: 2, type: 'ctrl.ping', payload: {} });
  const pong = JSON.parse(ws.sent.at(-1) ?? '{}');
  assert.equal(pong.type, 'ctrl.pong');
});

test('inbound frames are forwarded with an assigned event id order', () => {
  const { ws, producer, frames } = setup();
  producer.start();
  ws.emitFrame({ v: 1, id: 'a', ts: 1, type: 'ctrl.auth.complete', payload: {} });
  ws.emitFrame({ v: 1, id: 'c', ts: 3, type: 'evt.session.message', payload: { x: 1 } });
  assert.deepEqual(frames.map((frame) => (frame as { type: string }).type), ['ctrl.auth.complete', 'evt.session.message']);
});

test('a malformed frame is dropped without closing, a superseded close carries a reason', () => {
  const { ws, producer } = setup();
  producer.start();
  ws.emit('message', 'not json');
  assert.equal(ws.closed.length, 0);
  producer.close('superseded');
  const reason = JSON.parse(ws.sent.at(-1) ?? '{}');
  assert.equal(reason.type, 'ctrl.disconnect_reason');
  assert.equal(reason.payload.code, 'superseded');
  assert.equal(ws.closed.at(-1)?.code, 1000);
});
