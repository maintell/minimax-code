import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeviceIdentityStore,
  PairingClient,
  RemoteControlProxy,
} from '../../../electron/vendor/@mavis/remote-control-bridge/dist/index.js';

// The acceptance test names this install through /api/state, so the double's
// durable device id is pinned rather than generated.
const DEVICE_ID = 'dev-e2e';
const CLIENT_VERSION = '0.0.0-e2e';

// Standard SSE framing: the bridge joins consecutive `data:` lines into one
// event and only flushes on a blank line, so each frame is separated by one.
const SSE_BODY = [
  'data: {"type":2,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
  '',
  'data: {"type":10}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function nothingToYield(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

export async function startProducerDouble(options: { prcUrl: string; password: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'prc-producer-'));
  const statePath = path.join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ desktop_device_id: DEVICE_ID }));

  const identity = new DeviceIdentityStore(statePath, silent);
  const pairingClient = new PairingClient({
    baseUrl: options.prcUrl,
    logger: silent,
    getJwt: () => 'e2e',
    getUserId: () => 'e2e-user',
    getDeviceId: () => identity.getDeviceId(),
    getPlatform: () => 'desktop',
    getAppVersion: () => CLIENT_VERSION,
    getDeviceName: async () => 'e2e producer',
    // The producer has no cloud JWT: PRC is told the operator password instead.
    getExtraHeaders: () => ({ 'X-PRC-Password': options.password, 'X-Client-Version': CLIENT_VERSION }),
    fetchImpl: fetch,
  });

  const proxy = new RemoteControlProxy({
    identity,
    pairingClient,
    logger: silent,
    clientVersion: CLIENT_VERSION,
    isRuntimeHealthy: () => true,
    getCurrentUserId: () => 'e2e-user',
    getWebSocketHeaders: () => ({}),
    requestRendererRefresh: () => {},
    localRuntimeInvoke: async (request: Request) => {
      const url = new URL(request.url, 'http://local');
      if (request.method === 'POST' && /\/session\/[^/]+\/message$/u.test(url.pathname)) {
        return new Response(SSE_BODY, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      if (request.method === 'GET' && url.pathname.endsWith('/agent/mavis/session/tree')) {
        return new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
    globalEventSource: async function* (signal: AbortSignal) {
      await nothingToYield(signal);
    },
  });

  // The shipped bridge keeps the credential fetch on the renderer side; here the
  // double is both ends, so it reads the binding through the real PairingClient
  // and feeds the result to the proxy's documented entry point.
  const wire = (await pairingClient.getBinding()) as Record<string, unknown>;
  const bindingId = typeof wire.binding_id === 'number' ? wire.binding_id : undefined;
  const ticket = typeof wire.ticket === 'string' ? wire.ticket : '';
  const endpoint = typeof wire.endpoint === 'string' ? wire.endpoint : '';
  const generation = typeof wire.producer_generation === 'number' ? wire.producer_generation : undefined;
  if (wire.state !== 'bound' || bindingId === undefined || !ticket || !endpoint) {
    throw new Error(`PRC did not report a bound producer (state=${String(wire.state)})`);
  }
  proxy.applyRendererCredentials({
    binding_id: bindingId,
    ticket,
    endpoint,
    ...(generation !== undefined ? { producer_generation: generation } : {}),
  });
  const connected = await proxy.connect();
  if (connected.phase !== 'connected') throw new Error(`producer did not connect (phase=${String(connected.phase)})`);

  return {
    async stop(): Promise<void> {
      await proxy.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
