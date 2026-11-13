import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.ts';

const webDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'web');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export async function createServer(deps: { config: Config }) {
  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://prc.local');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'invalid_request_target' } }));
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('..')) {
      res.writeHead(400).end();
      return;
    }
    try {
      const body = await readFile(path.join(webDir, file));
      res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(deps.config.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : deps.config.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
