import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConsumerHub, handleConsumerFrame } from '../src/consumer.ts';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(text: string) { this.sent.push(text); }
}

test('broadcast reaches every socket of the binding only', () => {
  const hub = new ConsumerHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  const other = new FakeSocket();
  hub.addSocket(a as never, 1);
  hub.addSocket(b as never, 1);
  hub.addSocket(other as never, 2);
  hub.broadcast(1, { kind: 'evt', type: 'session.message_chunk' });
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 1);
  assert.equal(other.sent.length, 0);
  assert.equal(hub.socketCount(1), 2);
});

test('a cmd frame is translated and its result is answered on the same socket', async () => {
  const socket = new FakeSocket();
  const router = {
    request: async () => ({ kind: 'ack' as const, payload: { sessions: [] } }),
  };
  await handleConsumerFrame(
    new ConsumerHub(), router as never, socket as never, 1,
    JSON.stringify({ kind: 'cmd', requestId: 'r1', type: 'session.list', payload: {} }),
  );
  const reply = JSON.parse(socket.sent.at(-1) ?? '{}');
  assert.equal(reply.kind, 'ack');
  assert.equal(reply.requestId, 'r1');
});

test('removeSocket narrows the fan-out and drops an empty binding', () => {
  const hub = new ConsumerHub();
  const a = new FakeSocket();
  const b = new FakeSocket();
  hub.addSocket(a as never, 1);
  hub.addSocket(b as never, 1);
  hub.removeSocket(a as never, 1);
  assert.equal(hub.socketCount(1), 1);
  hub.removeSocket(b as never, 1);
  assert.equal(hub.socketCount(1), 0);
});

test('malformed browser messages are dropped without a reply or a throw', async () => {
  const socket = new FakeSocket();
  const calls: unknown[] = [];
  const router = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return { kind: 'ack' as const, payload: {} };
    },
  };
  const raw = [
    'not json',
    'null',
    '[]',
    '{}',
    JSON.stringify({ kind: 'cmd' }),
    JSON.stringify({ kind: 'cmd', type: '', payload: {} }),
    JSON.stringify({ kind: 'cmd', type: 'session.list', payload: [] }),
    JSON.stringify({ kind: 'permission' }),
  ];
  for (const message of raw) {
    await handleConsumerFrame(new ConsumerHub(), router as never, socket as never, 1, message);
  }
  assert.equal(socket.sent.length, 0);
  assert.equal(calls.length, 0);
});

test('a permission decision becomes the numeric producer response', async () => {
  const socket = new FakeSocket();
  const calls: Array<{ bindingId: number; type: string; payload: Record<string, unknown> }> = [];
  const router = {
    request: async (bindingId: number, type: string, payload: Record<string, unknown>) => {
      calls.push({ bindingId, type, payload });
      return { kind: 'ack' as const, payload: { processed: 2, skipped: 0 } };
    },
  };
  await handleConsumerFrame(
    new ConsumerHub(), router as never, socket as never, 7,
    JSON.stringify({ kind: 'permission', requestId: 'r2', decision: 'deny', requestIds: ['p1', 2] }),
  );
  assert.deepEqual(calls, [
    { bindingId: 7, type: 'cmd.permission.respond', payload: { request_ids: ['p1', '2'], decision: 2 } },
  ]);
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? '{}'), {
    kind: 'ack',
    payload: { processed: 2, skipped: 0 },
    requestId: 'r2',
  });
});

test('an unrecognised permission decision is dropped rather than treated as allow', async () => {
  const socket = new FakeSocket();
  const calls: string[] = [];
  const router = {
    request: async (_bindingId: number, type: string) => {
      calls.push(type);
      return { kind: 'ack' as const, payload: {} };
    },
  };
  await handleConsumerFrame(
    new ConsumerHub(), router as never, socket as never, 1,
    JSON.stringify({ kind: 'permission', requestId: 'r3', decision: 'allowForever', requestIds: ['p1'] }),
  );
  assert.deepEqual(calls, []);
  assert.equal(socket.sent.length, 0);
});

test('a socket that closes mid-command does not reject the handler', async () => {
  const socket = {
    send() {
      throw new Error('socket is closing');
    },
  };
  const router = { request: async () => ({ kind: 'ack' as const, payload: {} }) };
  await assert.doesNotReject(() => handleConsumerFrame(
    new ConsumerHub(), router as never, socket as never, 1,
    JSON.stringify({ kind: 'cmd', requestId: 'r4', type: 'session.list', payload: {} }),
  ));
});
