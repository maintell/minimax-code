import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../src/auth.ts';
import { createHttpApi } from '../src/http.ts';
import { createServer } from '../src/server.ts';
import { openStore } from '../src/store.ts';

const BINDINGS = '/minimax-cloud/api/v1/remote-control/desktop/bindings';
const UNBIND = '/minimax-cloud/api/v1/remote-control/unbind';

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-producer-http-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const config = { port: 0, dataDir: dir, publicUrl: 'https://prc.example.com', trustProxy: false };
  const api = createHttpApi({
    auth: createAuth('secret'),
    store,
    router: { request: async () => ({ kind: 'ack', payload: {} }) } as never,
    config,
    passwordHash: hashPassword('pw'),
  });
  const server = await createServer({ config, api });
  return {
    server,
    store,
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
