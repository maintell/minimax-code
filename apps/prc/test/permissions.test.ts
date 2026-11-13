import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../src/auth.ts';
import { ConsumerHub, eventFanout, toPermissionCard } from '../src/consumer.ts';
import type { Frame } from '../src/frames.ts';
import { createHttpApi } from '../src/http.ts';
import { createServer } from '../src/server.ts';
import { openStore } from '../src/store.ts';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(text: string) { this.sent.push(text); }
}

function producerFrame(type: string, payload: Record<string, unknown>, eventId: number): Frame {
  return { v: 1, id: `f-${eventId}`, ts: 0, type, payload, event_id: eventId };
}

test('permission asks are normalised for rendering', () => {
  const card = toPermissionCard({
    session_id: 's1', request_id: 'p1', tool_name: 'Bash',
    tool_input: '{"cmd":"ls"}', rule_contents: 'ls\npwd', reason: 'needs shell',
  });
  assert.deepEqual(card, {
    requestId: 'p1', sessionId: 's1', toolName: 'Bash',
    toolInput: '{"cmd":"ls"}', ruleContents: 'ls\npwd', reason: 'needs shell',
  });
});

test('missing optional fields degrade to empty strings', () => {
  const card = toPermissionCard({ session_id: 's1', request_id: 'p1', tool_name: 'Read' });
  assert.equal(card.toolInput, '');
  assert.equal(card.reason, '');
});

test('acknowledgements and control frames stay off the browser fanout', () => {
  const hub = new ConsumerHub();
  const socket = new FakeSocket();
  hub.addSocket(socket as never, 1);
  eventFanout(hub, 1, producerFrame('ack.session.send', { message_id: 'm1' }, 1));
  eventFanout(hub, 1, producerFrame('ack.permission.respond', { processed: 1 }, 2));
  eventFanout(hub, 1, producerFrame('err.session.send', { code: 'BAD_REQUEST' }, 3));
  eventFanout(hub, 1, producerFrame('ctrl.disconnect_reason', { code: 'superseded' }, 4));
  // A reply settles its own request; a tab has nothing to do with it.
  assert.deepEqual(socket.sent, []);

  eventFanout(hub, 1, producerFrame('evt.session.message_chunk', { session_id: 's1' }, 5));
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? '{}'), {
    kind: 'evt',
    type: 'evt.session.message_chunk',
    payload: { session_id: 's1' },
    eventId: 5,
  });
});

test('a permission ask is fanned out as a card and its resolution stays raw', () => {
  const hub = new ConsumerHub();
  const socket = new FakeSocket();
  hub.addSocket(socket as never, 2);
  eventFanout(hub, 2, producerFrame('evt.permission.ask', {
    session_id: 's1', request_id: 'p1', tool_name: 'Bash',
    tool_input: '{"cmd":"ls"}', rule_contents: 'ls\npwd', reason: 'needs shell',
  }, 6));
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? '{}'), {
    kind: 'evt',
    type: 'evt.permission.ask',
    payload: {
      requestId: 'p1', sessionId: 's1', toolName: 'Bash',
      toolInput: '{"cmd":"ls"}', ruleContents: 'ls\npwd', reason: 'needs shell',
    },
    eventId: 6,
  });

  // Every tab closes the card from the producer's own payload.
  eventFanout(hub, 2, producerFrame('evt.permission.resolved', { request_id: 'p1', decision: 1 }, 7));
  assert.deepEqual(JSON.parse(socket.sent.at(-1) ?? '{}'), {
    kind: 'evt',
    type: 'evt.permission.resolved',
    payload: { request_id: 'p1', decision: 1 },
    eventId: 7,
  });
});

type StubResult =
  | { kind: 'ack'; payload: Record<string, unknown> }
  | { kind: 'err'; code: string; message: string; retryable: boolean };

interface Call {
  bindingId: number;
  type: string;
  payload: Record<string, unknown>;
}

async function boot(request?: (call: Call) => Promise<StubResult>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-permission-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const config = {
    port: 0,
    dataDir: dir,
    publicUrl: 'http://127.0.0.1',
    trustProxy: false,
  };
  const calls: Call[] = [];
  const router = {
    request: async (bindingId: number, type: string, payload: Record<string, unknown>) => {
      const call = { bindingId, type, payload };
      calls.push(call);
      return request ? request(call) : { kind: 'ack' as const, payload: { processed: 1, skipped: 0 } };
    },
  };
  const api = createHttpApi({
    auth: createAuth('secret'), store, router: router as never, config,
    passwordHash: hashPassword('pw'),
  });
  const server = await createServer({ config, api });
  return { server, store, calls };
}

async function signIn(server: { url: string }) {
  const response = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const body = (await response.json()) as { csrf: string };
  return { cookies, csrf: body.csrf };
}

test('allow decisions carry their remember code and deny sends 2', async () => {
  const { server, store, calls } = await boot(
    async () => ({ kind: 'ack', payload: { processed: 2, skipped: 1 } }),
  );
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const { cookies, csrf } = await signIn(server);
  const reply = (decision: string) => fetch(`${server.url}/api/permissions/p1`, {
    method: 'POST',
    headers: {
      cookie: cookies, 'x-csrf-token': csrf, 'x-device-id': 'dev-1', 'content-type': 'application/json',
    },
    body: JSON.stringify({ decision }),
  });

  // Without `remember` the producer reads an allow as a one-off approval, so
  // "Allow always" would silently degrade to "Allow once".
  const cases = [
    ['allowOnce', { request_ids: ['p1'], decision: 1, remember: 3 }],
    ['allowAlways', { request_ids: ['p1'], decision: 1, remember: 1 }],
    ['deny', { request_ids: ['p1'], decision: 2 }],
  ] as const;
  for (const [decision, payload] of cases) {
    const response = await reply(decision);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, processed: 2, skipped: 1 });
    assert.deepEqual(calls.at(-1), {
      bindingId: binding.id,
      type: 'cmd.permission.respond',
      payload,
    });
  }
  assert.equal(calls.length, 3);
  await server.close();
});

test('an unknown decision is refused without reaching the producer', async () => {
  const { server, store, calls } = await boot();
  store.getOrCreateBinding('dev-1', '3.1.14');
  const { cookies, csrf } = await signIn(server);
  const response = await fetch(`${server.url}/api/permissions/p1`, {
    method: 'POST',
    headers: {
      cookie: cookies, 'x-csrf-token': csrf, 'x-device-id': 'dev-1', 'content-type': 'application/json',
    },
    body: JSON.stringify({ decision: 'allowForever' }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'INVALID_DECISION' } });
  assert.deepEqual(calls, []);
  await server.close();
});

test('a permission reply sits behind the session, csrf and binding gates', async () => {
  const { server, calls } = await boot();
  const reply = (headers: Record<string, string>) => fetch(`${server.url}/api/permissions/p1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ decision: 'deny' }),
  });

  assert.equal((await reply({})).status, 401);
  const { cookies, csrf } = await signIn(server);
  assert.equal((await reply({ cookie: cookies })).status, 403);
  const noBinding = await reply({ cookie: cookies, 'x-csrf-token': csrf });
  assert.equal(noBinding.status, 409);
  assert.deepEqual(await noBinding.json(), { error: { code: 'NO_BINDING' } });
  assert.deepEqual(calls, []);
  await server.close();
});

test('a producer failure answers 502 instead of a decision', async () => {
  const { server, store } = await boot(async () => ({
    kind: 'err', code: 'COMMAND_TIMEOUT', message: 'cmd.permission.respond timed out', retryable: true,
  }));
  store.getOrCreateBinding('dev-1', '3.1.14');
  const { cookies, csrf } = await signIn(server);
  const response = await fetch(`${server.url}/api/permissions/p1`, {
    method: 'POST',
    headers: {
      cookie: cookies, 'x-csrf-token': csrf, 'x-device-id': 'dev-1', 'content-type': 'application/json',
    },
    body: JSON.stringify({ decision: 'allowOnce' }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'COMMAND_TIMEOUT');
  await server.close();
});
