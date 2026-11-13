import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyPassword } from './auth.ts';
import type { Auth } from './auth.ts';
import type { CommandRouter } from './commands.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';

export const SESSION_COOKIE = 'prc_session';
const CSRF_COOKIE = 'prc_csrf';

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
  nowMs?: () => number;
}) {
  const now = deps.nowMs ?? Date.now;
  // The design spec asks for Secure except on a declared plaintext origin, and
  // the origin is already described by the public URL.
  const secureSuffix = deps.config.publicUrl.startsWith('https:') ? '; Secure' : '';

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://prc.local');
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

      const binding = deps.store.findBindingByDevice(String(req.headers['x-device-id'] ?? '')) ?? undefined;
      const bindingId = binding?.id;

      if (req.method === 'GET' && url.pathname === '/api/state') {
        return send(res, 200, {
          binding: binding ? { id: binding.id, deviceId: binding.deviceId, generation: binding.producerGeneration } : null,
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

      return send(res, 404, { error: { code: 'not_found' } }), true;
    },
  };
}
