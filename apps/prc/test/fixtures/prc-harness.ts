import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createAuth, hashPassword, type Auth } from '../../src/auth.ts';
import { CommandRouter } from '../../src/commands.ts';
import type { Config } from '../../src/config.ts';
import { ConsumerHub } from '../../src/consumer.ts';
import { createHttpApi } from '../../src/http.ts';
import type { Logger, ProducerSocket } from '../../src/producer.ts';
import { createServer } from '../../src/server.ts';
import { openStore, type Store } from '../../src/store.ts';

// The console API answers JSON without a schema and the test indexes it directly.
type Json = Record<string, any>;

const silent: Logger = { info() {}, warn() {}, error() {} };

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export class HarnessSocket {
  private readonly messages: Json[] = [];
  private readonly notifiers: Array<() => void> = [];
  private readonly ws: WebSocket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as Json);
      for (const notify of this.notifiers.splice(0)) notify();
    });
  }

  send(text: string): void {
    this.ws.send(text);
  }

  async next(predicate: (message: Json) => boolean): Promise<Json> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error('timed out waiting for a socket message');
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

export async function startPrc(options: { password: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-e2e-'));
  const config: Config = { port: 0, dataDir: dir, publicUrl: 'http://127.0.0.1', trustProxy: false };
  const store: Store = openStore(path.join(dir, 'prc.sqlite'));
  const auth: Auth = createAuth('e2e-secret');
  const hub = new ConsumerHub();
  const producers = new Map<number, ProducerSocket>();
  const router = new CommandRouter({ getProducer: (bindingId) => producers.get(bindingId), logger: silent });
  const api = createHttpApi({ auth, store, router, config, passwordHash: hashPassword(options.password) });
  const server = await createServer({ config, api, realtime: { auth, store, router, hub, producers, logger: silent } });
  // The producer's socket endpoint is derived from the operator's public URL,
  // and this listener only learns its port when it binds.
  config.publicUrl = server.url;
  const wsBase = server.url.replace(/^http/u, 'ws');

  let cookie = '';
  const sockets: HarnessSocket[] = [];

  async function login(password: string): Promise<{ ok: boolean; csrf: string }> {
    const response = await fetch(`${server.url}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }),
    });
    cookie = response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
    const body = (await response.json()) as { csrf?: string };
    return { ok: response.ok, csrf: body.csrf ?? '' };
  }

  async function get(pathname: string, init: { headers?: Record<string, string> } = {}): Promise<Json> {
    const response = await fetch(`${server.url}${pathname}`, { headers: { cookie, ...(init.headers ?? {}) } });
    return (await response.json()) as Json;
  }

  async function openSocket(): Promise<HarnessSocket> {
    // A tab cannot route a command before the producer's handshake completes,
    // and it discovers the binding the way the console does: the sole device.
    await waitFor(() => [...producers.values()].some((producer) => producer.isAuthed()), 'producer authentication');
    const state = await get('/api/state');
    const binding = state.binding as { id?: number } | null;
    if (!binding?.id) throw new Error('no binding to open a socket for');
    const ws = new WebSocket(`${wsBase}/ws?binding_id=${binding.id}`, { headers: { cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const socket = new HarnessSocket(ws);
    sockets.push(socket);
    return socket;
  }

  async function close(): Promise<void> {
    for (const socket of sockets.splice(0)) socket.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return { url: server.url, login, get, openSocket, close };
}
