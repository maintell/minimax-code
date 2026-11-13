import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/commands.ts';
import type { ProducerSocket } from '../src/producer.ts';

function fakeProducer() {
  const sent: Array<{ id?: string; type: string; payload: Record<string, unknown> }> = [];
  const producer = {
    isAuthed: () => true,
    send(type: string, payload: Record<string, unknown>, opts?: { id?: string }) {
      sent.push({ ...(opts?.id ? { id: opts.id } : {}), type, payload });
      return { id: opts?.id ?? 'frame-1', type, payload } as never;
    },
  } as unknown as ProducerSocket;
  return { producer, sent };
}

test('a command is sent with a fresh id and resolves on the matching ack', async () => {
  const { producer, sent } = fakeProducer();
  const router = new CommandRouter({ getProducer: () => producer, logger: { info() {}, warn() {}, error() {} } });
  const pending = router.request(1, 'cmd.session.send', { session_id: 's1', content: 'hi' });
  const cmdId = router.pendingCommandId(1);
  assert.ok(cmdId);
  assert.equal(sent[0]?.type, 'cmd.session.send');
  assert.equal(sent[0]?.id, cmdId);
  router.settle({ v: 1, id: 'f', ts: 1, type: 'ack.session.send', payload: { disposition: 'sent' }, in_reply_to: cmdId });
  const result = await pending;
  assert.deepEqual(result, { kind: 'ack', payload: { disposition: 'sent' } });
});

test('an error frame resolves as a retryable error result', async () => {
  const { producer } = fakeProducer();
  const router = new CommandRouter({ getProducer: () => producer, logger: { info() {}, warn() {}, error() {} } });
  const pending = router.request(1, 'cmd.session.stop', { session_id: 's1' });
  const cmdId = router.pendingCommandId(1);
  router.settle({ v: 1, id: 'f', ts: 1, type: 'err.session.stop', payload: { code: 'SESSION_BUSY', message: 'busy', retryable: true }, in_reply_to: cmdId });
  const result = await pending;
  assert.equal(result.kind, 'err');
  if (result.kind === 'err') {
    assert.equal(result.code, 'SESSION_BUSY');
    assert.equal(result.retryable, true);
  }
});

test('a missing producer fails immediately and silence times out', async () => {
  const router = new CommandRouter({ getProducer: () => undefined, logger: { info() {}, warn() {}, error() {} } });
  const offline = await router.request(1, 'cmd.session.list', {});
  assert.equal(offline.kind, 'err');
  if (offline.kind === 'err') assert.equal(offline.code, 'PRODUCER_OFFLINE');

  const { producer } = fakeProducer();
  const router2 = new CommandRouter({ getProducer: () => producer, logger: { info() {}, warn() {}, error() {} } });
  const slow = await router2.request(1, 'cmd.session.list', {}, { timeoutMs: 10 });
  assert.equal(slow.kind, 'err');
  if (slow.kind === 'err') assert.equal(slow.code, 'COMMAND_TIMEOUT');
});

test('cancelAll resolves every pending request for the binding', async () => {
  const { producer } = fakeProducer();
  const router = new CommandRouter({ getProducer: () => producer, logger: { info() {}, warn() {}, error() {} } });
  const pending = router.request(1, 'cmd.session.send', { session_id: 's1', content: 'x' });
  router.cancelAll(1, 'producer_disconnected');
  const result = await pending;
  assert.equal(result.kind, 'err');
  if (result.kind === 'err') assert.equal(result.code, 'PRODUCER_DISCONNECTED');
});

test('settle only consumes frames whose in_reply_to matches a pending command', async () => {
  const { producer } = fakeProducer();
  const router = new CommandRouter({ getProducer: () => producer, logger: { info() {}, warn() {}, error() {} } });
  const pending = router.request(1, 'cmd.session.send', { session_id: 's1' });
  const cmdId = router.pendingCommandId(1);
  assert.ok(cmdId);

  assert.equal(router.settle({ v: 1, id: 'f1', ts: 1, type: 'evt.session.message', payload: {} }), false);
  assert.equal(router.settle({ v: 1, id: 'f2', ts: 1, type: 'ack.session.send', payload: {}, in_reply_to: 'cmd-other' }), false);
  assert.equal(router.settle({ v: 1, id: 'f3', ts: 1, type: 'ack.session.send', payload: { disposition: 'sent' }, in_reply_to: cmdId }), true);
  assert.deepEqual(await pending, { kind: 'ack', payload: { disposition: 'sent' } });
  assert.equal(router.settle({ v: 1, id: 'f4', ts: 1, type: 'ack.session.send', payload: {}, in_reply_to: cmdId }), false);
});

test('cancelAll leaves commands for other bindings pending', async () => {
  const { producer } = fakeProducer();
  const router = new CommandRouter({ getProducer: () => producer, logger: { info() {}, warn() {}, error() {} } });
  const cancelled = router.request(1, 'cmd.session.send', { session_id: 's1' });
  const kept = router.request(2, 'cmd.session.send', { session_id: 's2' });
  router.cancelAll(1, 'producer_disconnected');
  const cancelledResult = await cancelled;
  assert.equal(cancelledResult.kind, 'err');
  if (cancelledResult.kind === 'err') assert.equal(cancelledResult.code, 'PRODUCER_DISCONNECTED');

  const keptId = router.pendingCommandId(2);
  assert.ok(keptId);
  router.settle({ v: 1, id: 'f', ts: 1, type: 'ack.session.send', payload: { disposition: 'sent' }, in_reply_to: keptId });
  assert.deepEqual(await kept, { kind: 'ack', payload: { disposition: 'sent' } });
});
