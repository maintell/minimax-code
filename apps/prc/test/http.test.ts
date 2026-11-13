import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../src/auth.ts';
import { createHttpApi } from '../src/http.ts';
import { createServer } from '../src/server.ts';
import { openStore } from '../src/store.ts';

async function boot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-http-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const config = { port: 0, dataDir: dir, publicUrl: 'http://127.0.0.1' };
  const router = {
    request: async () => ({ kind: 'ack' as const, payload: { sessions: [{ id: 's1', title: 'one' }] } }),
  };
  const api = createHttpApi({
    auth: createAuth('secret'), store, router: router as never, config,
    passwordHash: hashPassword('pw'),
  });
  const server = await createServer({ config, api });
  return { server, store };
}

async function signIn(server: { url: string }) {
  const response = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  });
  const cookies = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  return { status: response.status, cookies };
}

test('login rejects a wrong password and sets the session cookie on success', async () => {
  const { server } = await boot();
  const bad = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(bad.status, 401);
  const good = await signIn(server);
  assert.equal(good.status, 200);
  assert.ok(good.cookies.includes('prc_session='));
  await server.close();
});

test('state needs the cookie and sessions ride the device header', async () => {
  const { server, store } = await boot();
  assert.equal((await fetch(`${server.url}/api/state`)).status, 401);
  const { cookies } = await signIn(server);
  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const state = await fetch(`${server.url}/api/state`, {
    headers: { cookie: cookies, 'x-device-id': 'dev-1' },
  });
  assert.equal((await state.json()).binding.id, binding.id);
  const sessions = await fetch(`${server.url}/api/sessions`, {
    headers: { cookie: cookies, 'x-device-id': 'dev-1' },
  });
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json()).payload.sessions[0].id, 's1');
  await server.close();
});
