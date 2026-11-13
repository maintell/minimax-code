import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyPassword } from './auth.ts';
import type { Auth } from './auth.ts';
import type { CommandRouter } from './commands.ts';
import type { Config } from './config.ts';
import { permissionDecisionCode } from './consumer.ts';
import type { Store } from './store.ts';

export const SESSION_COOKIE = 'prc_session';
const CSRF_COOKIE = 'prc_csrf';
const RC_API_BASE = '/minimax-cloud/api/v1/remote-control';

// The producer speaks the shipped bridge's HTTP contract: the operator password
// travels in a header because a desktop install has no browser session, and the
// socket endpoint is derived from the URL the operator published.
function producerEndpoint(publicUrl: string): string {
  const url = new URL(publicUrl);
  return `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/rc`;
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function nearestHop(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (!raw) return undefined;
  let last: string | undefined;
  for (const hop of raw.split(',')) {
    const trimmed = hop.trim();
    if (trimmed) last = trimmed;
  }
  return last;
}

// The limiter must key on a value the client cannot choose. A proxy usually
// appends to x-forwarded-for, so only the rightmost hop (the address the
// closest trusted proxy saw) is trustworthy; the leftmost hop is client input.
function loginKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = nearestHop(req.headers['x-forwarded-for']);
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function createHttpApi(deps: {
  auth: Auth;
  store: Store;
  router: CommandRouter;
  config: Config;
  passwordHash: string;
  // Owned by the composition root, which holds the live producer registry.
  closeProducer?: (bindingId: number) => void;
  nowMs?: () => number;
}) {
  const now = deps.nowMs ?? Date.now;
  // The design spec asks for Secure except on a declared plaintext origin, and
  // the origin is already described by the public URL.
  const secureSuffix = deps.config.publicUrl.startsWith('https:') ? '; Secure' : '';

  // Producer routes bypass the cookie/CSRF gate by design: a desktop install has
  // no browser session, so it proves the operator password instead. The password
  // is checked before any binding is read or written, a wrong one can never
  // probe which device ids exist. Verification is scrypt and synchronous, so a
  // failure budget runs first: without it one client could stall the only event
  // loop. A missing header performs no scrypt work and so spends no budget.
  async function handleProducer(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const key = loginKey(req, deps.config.trustProxy);
    if (deps.auth.producerAuthBlocked(key, now())) {
      send(res, 429, { error: { code: 'RATE_LIMITED' } });
      return true;
    }
    const password = req.headers['x-prc-password'];
    if (typeof password !== 'string') {
      send(res, 401, { error: { code: 'not_authenticated' } });
      return true;
    }
    if (!verifyPassword(password, deps.passwordHash)) {
      deps.auth.recordProducerAuthFailure(key, now());
      send(res, 401, { error: { code: 'not_authenticated' } });
      return true;
    }

    if (req.method === 'GET' && url.pathname === `${RC_API_BASE}/desktop/bindings`) {
      const deviceHeader = req.headers['x-device-id'];
      const deviceId = typeof deviceHeader === 'string' ? deviceHeader.trim() : '';
      if (!deviceId) {
        send(res, 400, { error: { code: 'missing_device_id' } });
        return true;
      }
      // The binding read carries no protocol version of its own; the desktop
      // client names its build in X-Client-Version, which is recorded as-is.
      const versionHeader = req.headers['x-client-version'];
      const producerVersion = typeof versionHeader === 'string' && versionHeader.trim()
        ? versionHeader.trim()
        : 'unknown';
      const binding = deps.store.getOrCreateBinding(deviceId, producerVersion);
      // Every read mints a fresh one-shot ticket; mintTicket drops the previous
      // unconsumed one, so an old bundle can never be replayed.
      const { ticket } = deps.store.mintTicket(binding.id);
      send(res, 200, {
        state: 'bound',
        binding_id: binding.id,
        ticket,
        endpoint: producerEndpoint(deps.config.publicUrl),
        bound_at_ms: binding.boundAtMs,
        producer_generation: binding.producerGeneration,
        producer_version: binding.producerVersion,
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === `${RC_API_BASE}/unbind`) {
      const body = await readJson(req);
      const bindingId = body.binding_id;
      if (typeof bindingId !== 'number' || !Number.isSafeInteger(bindingId) || bindingId <= 0) {
        send(res, 400, { error: { code: 'invalid_binding_id' } });
        return true;
      }
      deps.store.deleteBinding(bindingId);
      // Deleting the row is not revocation: a socket that is already open keeps
      // serving its consumer until it is told to stop. The disconnect_reason is
      // what makes the bridge clear its local binding.
      deps.closeProducer?.(bindingId);
      send(res, 200, { ok: true });
      return true;
    }

    send(res, 404, { error: { code: 'not_found' } });
    return true;
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://prc.local');
      if (url.pathname.startsWith(`${RC_API_BASE}/`)) return handleProducer(req, res, url);
      if (!url.pathname.startsWith('/api/')) return false;

      if (req.method === 'POST' && url.pathname === '/api/login') {
        const key = loginKey(req, deps.config.trustProxy);
        if (!deps.auth.allowLogin(key, now())) return send(res, 429, { error: { code: 'RATE_LIMITED' } }), true;
        const body = await readJson(req);
        if (typeof body.password !== 'string' || !verifyPassword(body.password, deps.passwordHash)) {
          return send(res, 401, { error: { code: 'not_authenticated' } }), true;
        }
        const csrf = deps.auth.issueCsrf();
        res.setHeader('set-cookie', [
          `${SESSION_COOKIE}=${encodeURIComponent(deps.auth.issueCookie(now()))}; HttpOnly; SameSite=Lax; Path=/${secureSuffix}`,
          `${CSRF_COOKIE}=${csrf}; SameSite=Lax; Path=/${secureSuffix}`,
        ]);
        return send(res, 200, { ok: true, csrf }), true;
      }

      if (!deps.auth.verifyCookie(readCookie(req, SESSION_COOKIE), now())) {
        return send(res, 401, { error: { code: 'not_authenticated' } }), true;
      }

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating) {
        const csrf = readCookie(req, CSRF_COOKIE) ?? '';
        const header = req.headers['x-csrf-token'];
        if (!deps.auth.verifyCsrf(csrf, typeof header === 'string' ? header : undefined)) {
          return send(res, 403, { error: { code: 'csrf_failed' } }), true;
        }
      }

      const deviceHeader = req.headers['x-device-id'];
      const deviceId = typeof deviceHeader === 'string' ? deviceHeader : '';
      // A header the caller sent still decides even when it matches nothing.
      const hasDeviceHeader = deviceHeader !== undefined;
      const binding = deps.store.findBindingByDevice(deviceId) ?? undefined;
      const bindingId = binding?.id;

      if (req.method === 'GET' && url.pathname === '/api/state') {
        // Discovery for a console that cannot send a device header on every
        // request: with no header and exactly one binding, that binding is the
        // answer; with several, only the header identifies which one.
        const stateBinding = binding ?? (hasDeviceHeader ? undefined : deps.store.soleBinding());
        return send(res, 200, {
          binding: stateBinding
            ? { id: stateBinding.id, deviceId: stateBinding.deviceId, generation: stateBinding.producerGeneration }
            : null,
        }), true;
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        if (bindingId === undefined) return send(res, 409, { error: { code: 'NO_BINDING' } }), true;
        const result = await deps.router.request(bindingId, 'cmd.session.list', {
          ...(url.searchParams.get('agent') ? { agent: url.searchParams.get('agent') } : {}),
          ...(url.searchParams.get('keyword') ? { keyword: url.searchParams.get('keyword') } : {}),
        });
        return send(res, result.kind === 'ack' ? 200 : 502, result), true;
      }

      const historyMatch = /^\/api\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
      if (req.method === 'GET' && historyMatch) {
        if (bindingId === undefined) return send(res, 409, { error: { code: 'NO_BINDING' } }), true;
        const result = await deps.router.request(bindingId, 'cmd.session.history', {
          session_id: decodeURIComponent(historyMatch[1] ?? ''),
          ...(url.searchParams.get('before') ? { before_msg_id: url.searchParams.get('before') } : {}),
          ...(url.searchParams.get('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
        });
        if (result.kind === 'err') return send(res, 502, result), true;
        const messages = JSON.parse(String(result.payload.messages_json ?? '[]')) as unknown;
        return send(res, 200, { messages, hasMore: result.payload.has_more === true, oldestMsgId: result.payload.oldest_msg_id ?? '' }), true;
      }

      if (req.method === 'POST' && historyMatch) {
        if (bindingId === undefined) return send(res, 409, { error: { code: 'NO_BINDING' } }), true;
        const body = await readJson(req);
        const result = await deps.router.request(bindingId, 'cmd.session.send', {
          ...body,
          session_id: decodeURIComponent(historyMatch[1] ?? ''),
        });
        return send(res, result.kind === 'ack' ? 200 : 502, result), true;
      }

      const permissionMatch = /^\/api\/permissions\/([^/]+)$/u.exec(url.pathname);
      if (req.method === 'POST' && permissionMatch) {
        if (bindingId === undefined) return send(res, 409, { error: { code: 'NO_BINDING' } }), true;
        const body = await readJson(req);
        const decision = typeof body.decision === 'string' ? permissionDecisionCode(body.decision) : undefined;
        // An unrecognised decision must never be forwarded as an allow.
        if (decision === undefined) return send(res, 400, { error: { code: 'INVALID_DECISION' } }), true;
        const result = await deps.router.request(bindingId, 'cmd.permission.respond', {
          request_ids: [decodeURIComponent(permissionMatch[1] ?? '')],
          decision,
        });
        if (result.kind === 'err') return send(res, 502, result), true;
        return send(res, 200, {
          ok: true,
          processed: result.payload.processed ?? 0,
          skipped: result.payload.skipped ?? 0,
        }), true;
      }

      return send(res, 404, { error: { code: 'not_found' } }), true;
    },
  };
}
