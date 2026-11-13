import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyPassword } from './auth.ts';
import type { Auth } from './auth.ts';
import type { CommandRouter } from './commands.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';

const SESSION_COOKIE = 'prc_session';
const CSRF_COOKIE = 'prc_csrf';

function readCookie(req: IncomingMessage, name: string): string | undefined {
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

export function createHttpApi(deps: {
  auth: Auth;
  store: Store;
  router: CommandRouter;
  config: Config;
  passwordHash: string;
  nowMs?: () => number;
}) {
  const now = deps.nowMs ?? Date.now;

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://prc.local');
      if (!url.pathname.startsWith('/api/')) return false;

      if (req.method === 'POST' && url.pathname === '/api/login') {
        const key = req.socket.remoteAddress ?? 'unknown';
        if (!deps.auth.allowLogin(key, now())) return send(res, 429, { error: { code: 'RATE_LIMITED' } }), true;
        const body = await readJson(req);
        if (typeof body.password !== 'string' || !verifyPassword(body.password, deps.passwordHash)) {
          return send(res, 401, { error: { code: 'not_authenticated' } }), true;
        }
        const csrf = deps.auth.issueCsrf();
        res.setHeader('set-cookie', [
          `${SESSION_COOKIE}=${encodeURIComponent(deps.auth.issueCookie(now()))}; HttpOnly; SameSite=Lax; Path=/`,
          `${CSRF_COOKIE}=${csrf}; SameSite=Lax; Path=/`,
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

      return send(res, 404, { error: { code: 'not_found' } }), true;
    },
  };
}
