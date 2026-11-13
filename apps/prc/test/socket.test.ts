import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createAuth } from '../src/auth.ts';
import { CommandRouter } from '../src/commands.ts';
import { ConsumerHub } from '../src/consumer.ts';
import type { Logger, ProducerSocket } from '../src/producer.ts';
import { createServer } from '../src/server.ts';
import { openStore } from '../src/store.ts';

const logger: Logger = { info() {}, warn() {}, error() {} };
type Message = Record<string, unknown>;

class Client {
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  private readonly notifiers: Array<() => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as Message);
      for (const notify of this.notifiers.splice(0)) notify();
    });
    ws.on('close', () => {
      for (const notify of this.notifiers.splice(0)) notify();
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async next(predicate: (message: Message) => boolean, label: string): Promise<Message> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        this.notifiers.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  close(): void {
    this.ws.terminate();
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openClient(url: string, headers?: Record<string, string>): Promise<Client> {
  const ws = new WebSocket(url, headers ? { headers } : {});
  return new Promise<Client>((resolve, reject) => {
    ws.once('open', () => resolve(new Client(ws)));
    ws.once('error', reject);
  });
}

function upgradeStatus(url: string, headers?: Record<string, string>): Promise<number> {
  const ws = new WebSocket(url, headers ? { headers } : {});
  return new Promise<number>((resolve, reject) => {
    ws.once('unexpected-response', (_request, response) => {
      response.resume();
      const status = response.statusCode ?? 0;
      ws.terminate();
      resolve(status);
    });
    ws.once('open', () => {
      ws.terminate();
      reject(new Error('upgrade succeeded unexpectedly'));
    });
    ws.once('error', reject);
  });
}

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-socket-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const auth = createAuth('secret');
  const hub = new ConsumerHub();
  const producers = new Map<number, ProducerSocket>();
  const router = new CommandRouter({ getProducer: (bindingId) => producers.get(bindingId), logger });
  const server = await createServer({
    config: { port: 0, dataDir: dir, publicUrl: 'http://127.0.0.1', trustProxy: false },
    realtime: { auth, store, router, hub, producers, logger },
  });
  return {
    server,
    store,
    binding,
    auth,
    hub,
    producers,
    wsBase: server.url.replace('http://', 'ws://'),
    cookie: { cookie: `prc_session=${auth.issueCookie()}` },
  };
}

async function connectProducer(env: Awaited<ReturnType<typeof boot>>): Promise<Client> {
  const ticket = env.store.mintTicket(env.binding.id).ticket;
  const client = await openClient(`${env.wsBase}/rc?binding_id=${env.binding.id}&ticket=${ticket}`);
  await client.next((message) => message.type === 'ctrl.hello', 'ctrl.hello');
  client.send({ v: 1, id: 'auth-1', ts: Date.now(), type: 'ctrl.auth.complete', payload: {} });
  await waitFor(() => env.producers.get(env.binding.id)?.isAuthed() === true, 'producer auth');
  return client;
}

test('a producer upgrade with an invalid ticket is told ticket_invalid and closed', async () => {
  const env = await boot();
  try {
    const producer = await openClient(`${env.wsBase}/rc?binding_id=${env.binding.id}&ticket=nope`);
    const message = await producer.next((item) => item.type === 'ctrl.disconnect_reason', 'disconnect_reason');
    assert.equal((message.payload as Record<string, unknown>).code, 'ticket_invalid');
    assert.equal(env.producers.size, 0);
    producer.close();
  } finally {
    await env.server.close();
  }
});

test('a browser upgrade without a session cookie is answered 401', async () => {
  const env = await boot();
  try {
    const status = await upgradeStatus(`${env.wsBase}/ws?binding_id=${env.binding.id}`);
    assert.equal(status, 401);
    assert.equal(env.hub.socketCount(env.binding.id), 0);
  } finally {
    await env.server.close();
  }
});

test('a browser upgrade without a binding is answered 400', async () => {
  const env = await boot();
  try {
    const status = await upgradeStatus(`${env.wsBase}/ws`, env.cookie);
    assert.equal(status, 400);
    assert.equal(env.hub.socketCount(env.binding.id), 0);
  } finally {
    await env.server.close();
  }
});

test('an upgrade on an unknown path is destroyed', async () => {
  const env = await boot();
  try {
    await assert.rejects(() => openClient(`${env.wsBase}/nope`));
  } finally {
    await env.server.close();
  }
});

test('a producer frame reaches the browser socket of its binding only', async () => {
  const env = await boot();
  const producer = await connectProducer(env);
  const browser = await openClient(`${env.wsBase}/ws?binding_id=${env.binding.id}`, env.cookie);
  try {
    assert.equal(env.hub.socketCount(env.binding.id), 1);
    producer.send({
      v: 1,
      id: 'evt-1',
      ts: Date.now(),
      type: 'evt.session.message_chunk',
      payload: { session_id: 's1', chunk: { text: 'hi' } },
      event_id: 9,
    });
    const message = await browser.next((item) => item.kind === 'evt', 'evt');
    assert.deepEqual(message, {
      kind: 'evt',
      type: 'evt.session.message_chunk',
      payload: { session_id: 's1', chunk: { text: 'hi' } },
      eventId: 9,
    });
  } finally {
    browser.close();
    producer.close();
    await env.server.close();
    assert.equal(env.hub.socketCount(env.binding.id), 0);
  }
});

test('producer acknowledgements never reach a browser socket but permission asks do', async () => {
  const env = await boot();
  const producer = await connectProducer(env);
  const browser = await openClient(`${env.wsBase}/ws?binding_id=${env.binding.id}`, env.cookie);
  try {
    producer.send({
      v: 1,
      id: 'ack-9',
      ts: Date.now(),
      type: 'ack.session.send',
      payload: { message_id: 'm1' },
    });
    producer.send({
      v: 1,
      id: 'ask-1',
      ts: Date.now(),
      type: 'evt.permission.ask',
      payload: {
        session_id: 's1', request_id: 'p1', tool_name: 'Bash',
        tool_input: '{"cmd":"ls"}', rule_contents: 'ls', reason: 'needs shell',
      },
      event_id: 11,
    });
    const ask = await browser.next((message) => message.type === 'evt.permission.ask', 'permission ask');
    assert.deepEqual(ask, {
      kind: 'evt',
      type: 'evt.permission.ask',
      payload: {
        requestId: 'p1', sessionId: 's1', toolName: 'Bash',
        toolInput: '{"cmd":"ls"}', ruleContents: 'ls', reason: 'needs shell',
      },
      eventId: 11,
    });
    // The ack was sent before the ask, so its absence is settled, not a race.
    assert.equal(browser.messages.some((message) => message.type === 'ack.session.send'), false);
  } finally {
    browser.close();
    producer.close();
    await env.server.close();
  }
});

test('a browser command is routed to the producer and answered on the same socket', async () => {
  const env = await boot();
  const producer = await connectProducer(env);
  const browser = await openClient(`${env.wsBase}/ws?binding_id=${env.binding.id}`, env.cookie);
  try {
    browser.send({ kind: 'cmd', requestId: 'r1', type: 'session.list', payload: { keyword: 'demo' } });
    const command = await producer.next(
      (message) => typeof message.type === 'string' && message.type.startsWith('cmd.'),
      'cmd frame',
    );
    assert.equal(command.type, 'cmd.session.list');
    assert.deepEqual(command.payload, { keyword: 'demo' });
    assert.equal(typeof command.id, 'string');

    producer.send({
      v: 1,
      id: 'ack-1',
      ts: Date.now(),
      type: 'ack.session.list',
      payload: { sessions: [] },
      in_reply_to: command.id,
    });
    const reply = await browser.next((message) => message.kind === 'ack', 'command reply');
    assert.deepEqual(reply, { kind: 'ack', payload: { sessions: [] }, requestId: 'r1' });

    // The ack settles the request on the requesting socket. It belongs to
    // command correlation, not to the event stream, so the tabs must not see it.
    producer.send({
      v: 1,
      id: 'evt-2',
      ts: Date.now(),
      type: 'evt.session.message_chunk',
      payload: { session_id: 's1', chunk: { text: 'next' } },
      event_id: 10,
    });
    await browser.next(
      (message) => message.type === 'evt.session.message_chunk',
      'event after the ack',
    );
    assert.equal(browser.messages.some((message) => message.type === 'ack.session.list'), false);
  } finally {
    browser.close();
    producer.close();
    await env.server.close();
  }
});

test('a producer close clears the registry and cancels its pending commands', async () => {
  const env = await boot();
  const producer = await connectProducer(env);
  const browser = await openClient(`${env.wsBase}/ws?binding_id=${env.binding.id}`, env.cookie);
  try {
    browser.send({
      kind: 'cmd',
      requestId: 'r2',
      type: 'session.history',
      payload: { session_id: 's1' },
    });
    await producer.next((message) => message.type === 'cmd.session.history', 'pending command');
    producer.close();
    const reply = await browser.next(
      (message) => message.kind === 'err' && message.requestId === 'r2',
      'cancelled reply',
    );
    assert.equal(reply.code, 'PRODUCER_DISCONNECTED');
    await waitFor(() => env.producers.size === 0, 'producer registry cleared');
  } finally {
    browser.close();
    producer.close();
    await env.server.close();
  }
});

test('a second producer supersedes the first and keeps the new registration', async () => {
  const env = await boot();
  const first = await connectProducer(env);
  const browser = await openClient(`${env.wsBase}/ws?binding_id=${env.binding.id}`, env.cookie);
  try {
    browser.send({
      kind: 'cmd',
      requestId: 'r3',
      type: 'session.send',
      payload: { session_id: 's1', content: 'hi' },
    });
    await first.next((message) => message.type === 'cmd.session.send', 'command on the first producer');

    const second = await connectProducer(env);
    try {
      const reason = await first.next((message) => message.type === 'ctrl.disconnect_reason', 'superseded');
      assert.equal((reason.payload as Record<string, unknown>).code, 'superseded');

      // The command addressed to the replaced socket is failed, not left to time out.
      const reply = await browser.next(
        (message) => message.kind === 'err' && message.requestId === 'r3',
        'superseded command reply',
      );
      assert.equal(reply.code, 'PRODUCER_DISCONNECTED');
      assert.equal(reply.message, 'producer_superseded');

      await waitFor(() => first.ws.readyState === WebSocket.CLOSED, 'superseded socket closed');
      // The replaced socket's close must not delete the replacement.
      assert.equal(env.producers.size, 1);
      second.close();
      await waitFor(() => env.producers.size === 0, 'registry cleaned by the live producer');
    } finally {
      second.close();
    }
  } finally {
    browser.close();
    first.close();
    await env.server.close();
  }
});
