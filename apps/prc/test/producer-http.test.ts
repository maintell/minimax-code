import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../src/auth.ts';
import { createHttpApi } from '../src/http.ts';
import { ProducerSocket } from '../src/producer.ts';
import type { Logger } from '../src/producer.ts';
import { createServer } from '../src/server.ts';
import { openStore } from '../src/store.ts';

const BINDINGS = '/minimax-cloud/api/v1/remote-control/desktop/bindings';
const UNBIND = '/minimax-cloud/api/v1/remote-control/unbind';

const silent: Logger = { info() {}, warn() {}, error() {} };

class FakeWs extends EventEmitter {
  readonly sent: string[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  send(text: string): void {
    this.sent.push(text);
  }
  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
  }
}

async function boot(options: { trustProxy?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-producer-http-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const config = {
    port: 0,
    dataDir: dir,
    publicUrl: 'https://prc.example.com',
    trustProxy: options.trustProxy ?? false,
  };
  // The same registry the composition root holds, wired the same way.
  const producers = new Map<number, ProducerSocket>();
  const api = createHttpApi({
    auth: createAuth('secret'),
    store,
    router: { request: async () => ({ kind: 'ack', payload: {} }) } as never,
    config,
    passwordHash: hashPassword('pw'),
    closeProducer: (bindingId) => producers.get(bindingId)?.close('server_initiated_unbind'),
  });
  const server = await createServer({ config, api });
  return {
    server,
    store,
    producers,
    close: async () => {
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a missing or wrong producer password answers 401 and creates no binding', async () => {
  const env = await boot();
  try {
    const attempts: Array<Record<string, string>> = [
      { 'x-device-id': 'dev-1' },
      { 'x-device-id': 'dev-1', 'x-prc-password': 'nope' },
    ];
    for (const headers of attempts) {
      const response = await fetch(`${env.server.url}${BINDINGS}`, { headers });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: { code: 'not_authenticated' } });
    }
    assert.equal(env.store.findBindingByDevice('dev-1'), undefined);

    // The password header never substitutes for the browser session cookie.
    const state = await fetch(`${env.server.url}/api/state`, { headers: { 'x-prc-password': 'pw' } });
    assert.equal(state.status, 401);
  } finally {
    await env.close();
  }
});

test('an authenticated binding read creates the binding and mints a fresh ticket', async () => {
  const env = await boot();
  try {
    const headers = { 'x-prc-password': 'pw', 'x-device-id': 'dev-1', 'x-client-version': '3.1.14' };
    const first = await (await fetch(`${env.server.url}${BINDINGS}`, { headers })).json();
    assert.equal(first.state, 'bound');
    assert.equal(first.endpoint, 'wss://prc.example.com/rc');
    assert.equal(first.producer_version, '3.1.14');
    assert.equal(typeof first.ticket, 'string');
    assert.equal(env.store.findBindingByDevice('dev-1')?.id, first.binding_id);

    const second = await (await fetch(`${env.server.url}${BINDINGS}`, { headers })).json();
    assert.equal(second.binding_id, first.binding_id);
    assert.notEqual(second.ticket, first.ticket);

    const noDevice = await fetch(`${env.server.url}${BINDINGS}`, { headers: { 'x-prc-password': 'pw' } });
    assert.equal(noDevice.status, 400);
  } finally {
    await env.close();
  }
});

test('an authenticated unbind deletes the binding; an anonymous one does not', async () => {
  const env = await boot();
  try {
    const binding = env.store.getOrCreateBinding('dev-1', '3.1.14');
    const post = (headers: Record<string, string>) => fetch(`${env.server.url}${UNBIND}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ binding_id: binding.id }),
    });

    assert.equal((await post({ 'x-prc-password': 'nope' })).status, 401);
    assert.equal(env.store.getBinding(binding.id)?.id, binding.id);

    const ok = await post({ 'x-prc-password': 'pw' });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    assert.equal(env.store.getBinding(binding.id), undefined);
  } finally {
    await env.close();
  }
});

test('an authenticated unbind revokes the live producer socket', async () => {
  const env = await boot();
  try {
    const binding = env.store.getOrCreateBinding('dev-1', '3.1.14');
    const ws = new FakeWs();
    const producer = new ProducerSocket({
      socket: ws as never,
      bindingId: binding.id,
      store: env.store,
      logger: silent,
      onFrame: () => {},
      onClose: () => {},
    });
    env.producers.set(binding.id, producer);
    producer.start();

    const response = await fetch(`${env.server.url}${UNBIND}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prc-password': 'pw' },
      body: JSON.stringify({ binding_id: binding.id }),
    });
    assert.equal(response.status, 200);

    const frames = ws.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
    const reason = frames.find((frame) => frame.type === 'ctrl.disconnect_reason');
    assert.equal((reason?.payload as Record<string, unknown> | undefined)?.code, 'server_initiated_unbind');
    assert.deepEqual(ws.closed, [{ code: 1000, reason: 'server_initiated_unbind' }]);
    assert.equal(env.store.getBinding(binding.id), undefined);
  } finally {
    await env.close();
  }
});

test('wrong producer passwords are rate limited per address before any scrypt work', async () => {
  const env = await boot({ trustProxy: true });
  try {
    const url = `${env.server.url}${BINDINGS}`;
    const attempt = (key: string, password: string) => fetch(url, {
      headers: { 'x-prc-password': password, 'x-device-id': 'dev-1', 'x-forwarded-for': key },
    });

    for (let i = 0; i < 10; i += 1) {
      assert.equal((await attempt('1.2.3.4', 'nope')).status, 401, `failure ${i + 1}`);
    }
    const blocked = await attempt('1.2.3.4', 'nope');
    assert.equal(blocked.status, 429);
    assert.deepEqual(await blocked.json(), { error: { code: 'RATE_LIMITED' } });
    // The guard runs before the comparison, so a blocked key cannot keep
    // spending scrypt even when it finally guesses right.
    assert.equal((await attempt('1.2.3.4', 'pw')).status, 429);
    // A different address keeps its own budget.
    assert.equal((await attempt('5.6.7.8', 'nope')).status, 401);
    assert.equal(env.store.findBindingByDevice('dev-1'), undefined);
  } finally {
    await env.close();
  }
});

test('a correct producer password never consumes the failure budget', async () => {
  const env = await boot({ trustProxy: true });
  try {
    const url = `${env.server.url}${BINDINGS}`;
    const attempt = (password: string) => fetch(url, {
      headers: { 'x-prc-password': password, 'x-device-id': 'dev-1', 'x-forwarded-for': '9.9.9.9' },
    });

    for (let i = 0; i < 12; i += 1) {
      assert.equal((await attempt('pw')).status, 200, `success ${i + 1}`);
    }
    // Twelve successful reconnects left the budget untouched: the first wrong
    // password is still judged on its merits rather than answered 429.
    assert.equal((await attempt('nope')).status, 401);
  } finally {
    await env.close();
  }
});
