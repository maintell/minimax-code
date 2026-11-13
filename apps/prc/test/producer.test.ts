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

function producerFor(socket: unknown, store: ReturnType<typeof openStore>, bindingId: number) {
  return new ProducerSocket({
    socket: socket as never,
    bindingId,
    store,
    logger: { info() {}, warn() {}, error() {} },
    onFrame: () => {},
    onClose: () => {},
  });
}

function wireFrames(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent.map((text) => JSON.parse(text));
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

test('send allocates binding-scoped event ids and a second binding starts at 1', () => {
  const { store, binding, ws, producer } = setup();
  producer.start();
  const first = producer.send('evt.one', { n: 1 });
  const second = producer.send('evt.two', { n: 2 });
  assert.equal(first.event_id, 1);
  assert.equal(second.event_id, 2);
  assert.deepEqual(wireFrames(ws).slice(1).map((frame) => frame.event_id), [1, 2]);

  const other = store.getOrCreateBinding('dev-2', '3.1.14');
  assert.notEqual(other.id, binding.id);
  const otherWs = new FakeWs();
  const otherProducer = producerFor(otherWs, store, other.id);
  otherProducer.start();
  assert.equal(otherProducer.send('evt.one', {}).event_id, 1);
  assert.deepEqual(wireFrames(otherWs).map((frame) => frame.event_id), [undefined, 1]);
});

test('the event is in the log before the frame reaches the socket', () => {
  const { store, binding } = setup();
  const snapshots: unknown[][] = [];
  const probe = {
    on() {},
    send() { snapshots.push(store.replayAfter(binding.id, 0)); },
    close() {},
  };
  const producer = producerFor(probe, store, binding.id);
  producer.start();
  const frame = producer.send('evt.session.message', { text: 'hi' });
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], []);
  const atSendTime = snapshots[1] as Array<{ type: string; event_id?: number }>;
  assert.equal(atSendTime.length, 1);
  assert.equal(atSendTime[0]?.type, 'evt.session.message');
  assert.equal(atSendTime[0]?.event_id, frame.event_id);
});

test('the logged frame and the wire frame are identical JSON', () => {
  const { store, binding, ws, producer } = setup();
  producer.start();
  const frame = producer.send('evt.session.message', { text: 'hi', nested: { ok: true } });
  const [logged] = store.replayAfter(binding.id, 0);
  const wire = JSON.parse(ws.sent.at(-1) ?? '{}');
  assert.deepEqual(logged, wire);
  assert.deepEqual(logged, JSON.parse(JSON.stringify(frame)));
});

test('an explicit id is used in the log and on the wire so in_reply_to can match', () => {
  const { store, binding, ws, producer } = setup();
  producer.start();
  producer.send('cmd.session.send', { session_id: 's1' }, { id: 'cmd-1', inReplyTo: 'req-0' });
  const wire = JSON.parse(ws.sent.at(-1) ?? '{}');
  const [logged] = store.replayAfter(binding.id, 0) as Array<Record<string, unknown>>;
  assert.equal(wire.id, 'cmd-1');
  assert.equal(logged?.id, 'cmd-1');
  assert.equal(wire.in_reply_to, 'req-0');
  assert.equal(logged?.in_reply_to, 'req-0');
  assert.equal(wire.event_id, logged?.event_id);
});

test('control frames never enter the replay stream', () => {
  const { store, binding, producer } = setup();
  producer.start();
  producer.send('evt.one', {});
  producer.close('superseded');
  const replayed = store.replayAfter(binding.id, 0) as Array<{ type: string }>;
  assert.deepEqual(replayed.map((frame) => frame.type), ['evt.one']);
});
