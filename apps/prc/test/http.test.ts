import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAuth, hashPassword } from '../src/auth.ts';
import { createHttpApi } from '../src/http.ts';
import { createServer } from '../src/server.ts';
import { openStore } from '../src/store.ts';

type StubResult =
  | { kind: 'ack'; payload: Record<string, unknown> }
  | { kind: 'err'; code: string; message: string; retryable: boolean };

interface BootOptions {
  publicUrl?: string;
  trustProxy?: boolean;
  request?: (bindingId: number, type: string, payload: Record<string, unknown>) => Promise<StubResult>;
}

async function boot(options: BootOptions = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-http-'));
  const store = openStore(path.join(dir, 'prc.sqlite'));
  const config = {
    port: 0,
    dataDir: dir,
    publicUrl: options.publicUrl ?? 'http://127.0.0.1',
    trustProxy: options.trustProxy ?? false,
  };
  const calls: Array<{ bindingId: number; type: string; payload: Record<string, unknown> }> = [];
  const request = options.request
    ?? (async () => ({ kind: 'ack' as const, payload: { sessions: [{ id: 's1', title: 'one' }] } }));
  const router = {
    request: async (bindingId: number, type: string, payload: Record<string, unknown>) => {
      calls.push({ bindingId, type, payload });
      return request(bindingId, type, payload);
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
  return { status: response.status, cookies, csrf: body.csrf };
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

test('state discovers the sole binding without a device header', async () => {
  const { server, store } = await boot();
  const { cookies } = await signIn(server);
  const only = store.getOrCreateBinding('dev-only', '3.1.14');

  const sole = await fetch(`${server.url}/api/state`, { headers: { cookie: cookies } });
  assert.equal(sole.status, 200);
  assert.equal((await sole.json()).binding.id, only.id);

  const second = store.getOrCreateBinding('dev-two', '3.1.14');
  const ambiguous = await fetch(`${server.url}/api/state`, { headers: { cookie: cookies } });
  assert.deepEqual(await ambiguous.json(), { binding: null });

  const headed = await fetch(`${server.url}/api/state`, {
    headers: { cookie: cookies, 'x-device-id': 'dev-two' },
  });
  assert.equal((await headed.json()).binding.id, second.id);

  // A header still decides even when it matches nothing; the sole binding is
  // never substituted for a device the caller named.
  const unknown = await fetch(`${server.url}/api/state`, {
    headers: { cookie: cookies, 'x-device-id': 'dev-unknown' },
  });
  assert.deepEqual(await unknown.json(), { binding: null });
  await server.close();
});

test('a mutating request answers 401 before csrf is considered', async () => {
  const { server } = await boot();
  const response = await fetch(`${server.url}/api/sessions/s1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'not_authenticated' } });
  await server.close();
});

test('a mutating request needs a csrf header matching the cookie', async () => {
  const { server } = await boot();
  const { cookies } = await signIn(server);
  const missing = await fetch(`${server.url}/api/sessions/s1/messages`, {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(missing.status, 403);
  assert.deepEqual(await missing.json(), { error: { code: 'csrf_failed' } });

  const wrong = await fetch(`${server.url}/api/sessions/s1/messages`, {
    method: 'POST',
    headers: { cookie: cookies, 'x-csrf-token': 'not-the-cookie', 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(wrong.status, 403);
  assert.deepEqual(await wrong.json(), { error: { code: 'csrf_failed' } });
  await server.close();
});

test('a send reaches the router with a binding and answers NO_BINDING without one', async () => {
  const { server, store, calls } = await boot();
  const { cookies, csrf } = await signIn(server);
  const headers = { cookie: cookies, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  const noBinding = await fetch(`${server.url}/api/sessions/s1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(noBinding.status, 409);
  assert.equal((await noBinding.json()).error.code, 'NO_BINDING');
  assert.equal(calls.length, 0);

  const binding = store.getOrCreateBinding('dev-1', '3.1.14');
  const sent = await fetch(`${server.url}/api/sessions/s1/messages`, {
    method: 'POST',
    headers: { ...headers, 'x-device-id': 'dev-1' },
    body: JSON.stringify({ content: 'hi' }),
  });
  assert.equal(sent.status, 200);
  const call = calls[0];
  assert.equal(calls.length, 1);
  assert.equal(call?.bindingId, binding.id);
  assert.equal(call?.type, 'cmd.session.send');
  assert.deepEqual(call?.payload, { content: 'hi', session_id: 's1' });
  await server.close();
});

test('five wrong logins are answered and the sixth is rate limited', async () => {
  const { server } = await boot();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${server.url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(response.status, 401);
  }
  const sixth = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(sixth.status, 429);
  assert.deepEqual(await sixth.json(), { error: { code: 'RATE_LIMITED' } });
  await server.close();
});

test('the login limiter keys on the hop the trusted proxy appended', async () => {
  const untrusted = await boot();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${untrusted.server.url}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${attempt}` },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(response.status, 401);
  }
  const spoofed = await fetch(`${untrusted.server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.99' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(spoofed.status, 429);
  await untrusted.server.close();

  const proxied = await boot({ trustProxy: true });
  const login = (forwardedFor?: string) => fetch(`${proxied.server.url}/api/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    body: JSON.stringify({ password: 'nope' }),
  });

  // A rotated leftmost hop must not mint a fresh bucket: the rightmost hop,
  // appended by the proxy, is the client address.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await login(`10.0.0.${attempt}, 10.0.0.9`)).status, 401);
  }
  assert.equal((await login('10.0.0.99, 10.0.0.9')).status, 429);

  // The same leftmost hop with different proxy-appended addresses stays allowed.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    assert.equal((await login(`10.0.0.9, 10.0.0.${attempt}`)).status, 401);
  }

  // Without the header the socket address is the key.
  assert.equal((await login()).status, 401);
  await proxied.server.close();
});

test('history parses messages_json and maps the page flags', async () => {
  const { server, store, calls } = await boot({
    request: async () => ({
      kind: 'ack',
      payload: { messages_json: '[]', has_more: false, oldest_msg_id: '' },
    }),
  });
  store.getOrCreateBinding('dev-1', '3.1.14');
  const { cookies } = await signIn(server);
  const response = await fetch(`${server.url}/api/sessions/s1/messages?before=m0&limit=10`, {
    headers: { cookie: cookies, 'x-device-id': 'dev-1' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { messages: [], hasMore: false, oldestMsgId: '' });
  assert.equal(calls[0]?.type, 'cmd.session.history');
  assert.deepEqual(calls[0]?.payload, { session_id: 's1', before_msg_id: 'm0', limit: 10 });
  await server.close();
});

test('a history error maps to 502', async () => {
  const { server, store } = await boot({
    request: async () => ({
      kind: 'err', code: 'PRODUCER_OFFLINE', message: 'producer is not connected', retryable: true,
    }),
  });
  store.getOrCreateBinding('dev-1', '3.1.14');
  const { cookies } = await signIn(server);
  const response = await fetch(`${server.url}/api/sessions/s1/messages`, {
    headers: { cookie: cookies, 'x-device-id': 'dev-1' },
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'PRODUCER_OFFLINE');
  await server.close();
});

test('cookies carry Secure only for an https public url', async () => {
  const secure = await boot({ publicUrl: 'https://prc.example.com' });
  const secureResponse = await fetch(`${secure.server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  });
  const secureCookies = secureResponse.headers.getSetCookie();
  assert.equal(secureCookies.length, 2);
  assert.ok(secureCookies.every((value) => value.includes('; Secure')));
  await secure.server.close();

  const plain = await boot();
  const plainResponse = await fetch(`${plain.server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'pw' }),
  });
  const plainCookies = plainResponse.headers.getSetCookie();
  assert.equal(plainCookies.length, 2);
  assert.ok(plainCookies.every((value) => !value.includes('Secure')));
  await plain.server.close();
});

test('a malformed login body answers 500 and the server keeps serving', async () => {
  const { server } = await boot();
  const bad = await fetch(`${server.url}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });
  assert.equal(bad.status, 500);
  assert.deepEqual(await bad.json(), { error: { code: 'internal_error' } });
  const health = await fetch(`${server.url}/healthz`);
  assert.equal(health.status, 200);
  await server.close();
});
