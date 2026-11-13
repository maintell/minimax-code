import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Frame } from '../src/frames.ts';
import { openStore } from '../src/store.ts';
import { ProducerSocket } from '../src/producer.ts';

class FakeWs extends EventEmitter {
  sent: string[] = [];
  send(text: string) { this.sent.push(text); }
  close() {}
}

function setup(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const ws = new FakeWs();
  const producer = new ProducerSocket({
    socket: ws as never,
    bindingId: binding.id,
    store,
    logger: { info() {}, warn() {}, error() {} },
    onFrame() {},
    onClose() {},
  });
  return { store, binding, ws, producer };
}

function producerFor(ws: FakeWs, store: ReturnType<typeof openStore>, bindingId: number) {
  return new ProducerSocket({
    socket: ws as never,
    bindingId,
    store,
    logger: { info() {}, warn() {}, error() {} },
    onFrame() {},
    onClose() {},
  });
}

function authComplete(ws: FakeWs, payload: Record<string, unknown>) {
  ws.emit('message', JSON.stringify({ v: 1, id: 'x', ts: 1, type: 'ctrl.auth.complete', payload }));
}

// `from` skips the frames a reconnect already saw, so an assertion can target
// what the socket received in answer to auth.complete.
function wireFrames(ws: FakeWs, from = 0): Frame[] {
  return ws.sent.slice(from).map((text) => JSON.parse(text) as Frame);
}

test('reconnect replays frames after last_event_id', () => {
  const { ws, producer } = setup('prc-replay-');
  producer.send('evt.a', {});
  producer.send('evt.b', {});
  producer.start();
  const baseline = ws.sent.length;
  authComplete(ws, { last_event_id: 1 });
  const replayed = wireFrames(ws, baseline).filter((frame) => frame.type.startsWith('evt.'));
  assert.deepEqual(replayed.map((frame) => frame.type), ['evt.b']);
});

test('an evicted cursor produces replay.overflow', () => {
  const { ws, producer } = setup('prc-overflow-');
  producer.start();
  authComplete(ws, { last_event_id: 99_999 });
  const types = wireFrames(ws).map((frame) => frame.type);
  assert.ok(types.includes('ctrl.replay.overflow'));
});

test('a cursor-less auth replays nothing even when events are retained', () => {
  const { ws, producer } = setup('prc-replay-none-');
  producer.send('evt.a', {});
  producer.send('evt.b', {});
  producer.start();
  const baseline = ws.sent.length;
  authComplete(ws, {});
  assert.deepEqual(wireFrames(ws, baseline), []);
});

test('a command is not logged, so a cursor-less reconnect cannot re-deliver it', () => {
  const { store, binding, ws, producer } = setup('prc-replay-cmd-');
  producer.send('cmd.session.send', { session_id: 's1', content: 'hi' });
  // The command still carries its id on the wire; it is only kept out of the log.
  const [command] = wireFrames(ws);
  assert.equal(command?.type, 'cmd.session.send');
  assert.equal(command?.event_id, 1);
  assert.deepEqual(store.replayAfter(binding.id, 0), []);

  producer.start();
  const baseline = ws.sent.length;
  authComplete(ws, {});
  assert.deepEqual(wireFrames(ws, baseline), []);
});

test('an explicit cursor replays newer events across a command gap', () => {
  const { ws, producer } = setup('prc-replay-gap-');
  producer.send('evt.a', {});
  producer.send('cmd.session.list', {});
  producer.send('evt.b', {});
  producer.start();
  const baseline = ws.sent.length;
  authComplete(ws, { last_event_id: 1 });
  const replayed = wireFrames(ws, baseline);
  assert.deepEqual(replayed.map((frame) => frame.type), ['evt.b']);
  assert.deepEqual(replayed.map((frame) => frame.event_id), [3]);
});

test('a cursor ahead of the newest id overflows instead of replaying nothing', () => {
  const { ws, producer } = setup('prc-replay-ahead-');
  producer.send('evt.a', {});
  producer.send('evt.b', {});
  producer.start();
  const baseline = ws.sent.length;
  authComplete(ws, { last_event_id: 99_999 });
  const frames = wireFrames(ws, baseline);
  assert.deepEqual(frames.map((frame) => frame.type), ['ctrl.replay.overflow']);
});

test('a non-numeric cursor is treated as absent and replays nothing', () => {
  const { ws, producer } = setup('prc-replay-junk-');
  producer.send('evt.a', {});
  producer.start();
  const baseline = ws.sent.length;
  authComplete(ws, { last_event_id: 'abc' });
  const frames = wireFrames(ws, baseline);
  assert.deepEqual(frames, []);
});

test('a replayed frame is the stored frame verbatim and is not logged again', () => {
  const { store, binding, ws, producer } = setup('prc-replay-log-');
  producer.send('evt.a', { n: 1 });
  producer.send('evt.b', { n: 2 });
  producer.start();
  const retained = store.replayAfter(binding.id, 0);
  const baseline = ws.sent.length;
  authComplete(ws, { last_event_id: 1 });

  const replayed = wireFrames(ws, baseline);
  assert.deepEqual(replayed as unknown[], [retained[1]]);
  assert.deepEqual(replayed.map((frame) => frame.event_id), [2]);
  // Nothing was appended by the replay: the log is unchanged and the next
  // frame keeps the id after the highest logged one.
  assert.deepEqual(store.replayAfter(binding.id, 0), retained);
  assert.equal(producer.send('evt.c', {}).event_id, 3);
});

test('a replay cursor at the retained edge still replays and one behind overflows', () => {
  // 2 005 appends leave ids 6..2 005 retained, so 5 is the last cursor that can
  // be served from the window and 4 names a frame that is gone.
  const store = openStore(':memory:');
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  for (let eventId = 1; eventId <= 2_005; eventId += 1) {
    store.appendEvent(binding.id, eventId, { type: 'evt.trim', event_id: eventId });
  }

  const atEdgeWs = new FakeWs();
  producerFor(atEdgeWs, store, binding.id).start();
  authComplete(atEdgeWs, { last_event_id: 5 });
  const atEdgeTypes = wireFrames(atEdgeWs).map((frame) => frame.type);
  assert.equal(atEdgeTypes.includes('ctrl.replay.overflow'), false);
  assert.equal(atEdgeTypes.filter((type) => type === 'evt.trim').length, 2_000);

  const behindWs = new FakeWs();
  producerFor(behindWs, store, binding.id).start();
  authComplete(behindWs, { last_event_id: 4 });
  const behindTypes = wireFrames(behindWs).map((frame) => frame.type);
  assert.ok(behindTypes.includes('ctrl.replay.overflow'));
  assert.equal(behindTypes.includes('evt.trim'), false);
});
