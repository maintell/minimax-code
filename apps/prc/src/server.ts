import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { Auth } from './auth.ts';
import type { CommandRouter } from './commands.ts';
import type { Config } from './config.ts';
import { ConsumerHub, handleConsumerFrame } from './consumer.ts';
import { DEFAULT_MAX_MESSAGE_BYTES, makeFrame } from './frames.ts';
import { SESSION_COOKIE, readCookie } from './http.ts';
import { ProducerSocket } from './producer.ts';
import type { Logger } from './producer.ts';
import type { Binding, Store } from './store.ts';

const webDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'web');
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface RealtimeDeps {
  auth: Auth;
  store: Store;
  router: CommandRouter;
  hub: ConsumerHub;
  // Owned by main.ts; the socket layer is the only writer.
  producers: Map<number, ProducerSocket>;
  logger: Logger;
}

function rejectUpgrade(socket: Duplex, status: number, statusText: string, code: string): void {
  const body = JSON.stringify({ error: { code } });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function frameText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) {
    return Buffer.concat(data.filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk))).toString('utf8');
  }
  return String(data);
}

// A browser tab cannot scope its socket with a header, so the binding is taken
// from the query. One operator sees one binding; the lookup is explicit rather
// than implicit so a tab can never receive another binding's events.
function resolveBinding(url: URL, req: IncomingMessage, store: Store): Binding | undefined {
  const bindingId = Number(url.searchParams.get('binding_id') ?? '');
  if (Number.isSafeInteger(bindingId) && bindingId > 0) return store.getBinding(bindingId);
  const header = req.headers['x-device-id'];
  const deviceId = url.searchParams.get('device_id') ?? (typeof header === 'string' ? header : undefined);
  return deviceId ? store.findBindingByDevice(deviceId) : undefined;
}

export async function createServer(deps: {
  config: Config;
  api?: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> };
  realtime?: RealtimeDeps;
}) {
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
    if (deps.api) {
      try {
        if (await deps.api.handle(req, res)) return;
      } catch {
        // A handler failure must not leave the socket open or reject unhandled.
        if (!res.writableEnded) {
          if (res.headersSent) {
            res.end();
          } else {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'internal_error' } }));
          }
        }
        return;
      }
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

  // `ws` defaults to a 100 MiB payload, which would tear down frames between
  // 100 and 128 MiB instead of handling them at the advertised cap.
  const wss = new WebSocketServer({ noServer: true, maxPayload: DEFAULT_MAX_MESSAGE_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const realtime = deps.realtime;
    if (!realtime) {
      socket.destroy();
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://prc.local');
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname === '/rc') {
      const bindingId = Number(url.searchParams.get('binding_id') ?? '');
      const ticket = url.searchParams.get('ticket') ?? '';
      const binding = Number.isSafeInteger(bindingId) && bindingId > 0
        ? realtime.store.getBinding(bindingId)
        : undefined;
      if (!binding || !ticket || !realtime.store.consumeTicket(ticket, binding.id)) {
        realtime.logger.warn(`reject producer upgrade binding=${String(bindingId)}: ticket_invalid`);
        // The upgrade has to complete for the frame to be readable; the frame
        // is flushed before the socket is torn down.
        wss.handleUpgrade(req, socket, head, (ws) => {
          ws.send(
            JSON.stringify(makeFrame('ctrl.disconnect_reason', { code: 'ticket_invalid' })),
            () => ws.terminate(),
          );
        });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const previous = realtime.producers.get(binding.id);
        const producer = new ProducerSocket({
          socket: ws,
          bindingId: binding.id,
          store: realtime.store,
          logger: realtime.logger,
          onFrame: (frame) => {
            // A reply settles the browser request it belongs to before the same
            // frame is fanned out to the tabs.
            realtime.router.settle(frame);
            realtime.hub.broadcast(binding.id, {
              kind: 'evt',
              type: frame.type,
              payload: frame.payload,
              eventId: frame.event_id,
            });
          },
          onClose: () => {
            // A superseded socket closes after its replacement is registered;
            // only the current socket may clear the binding.
            if (realtime.producers.get(binding.id) !== producer) return;
            realtime.producers.delete(binding.id);
            realtime.router.cancelAll(binding.id, 'producer_disconnected');
          },
        });
        ws.on('error', (error: Error) => {
          realtime.logger.warn(`producer socket error binding=${binding.id}: ${error.message}`);
        });
        // Commands addressed to the replaced socket can never be answered; fail
        // them now instead of waiting for the router's timeout.
        if (previous) realtime.router.cancelAll(binding.id, 'producer_superseded');
        realtime.producers.set(binding.id, producer);
        producer.start();
        if (previous && previous !== producer) previous.close('superseded');
      });
      return;
    }

    if (url.pathname === '/ws') {
      if (!realtime.auth.verifyCookie(readCookie(req, SESSION_COOKIE), Date.now())) {
        rejectUpgrade(socket, 401, 'Unauthorized', 'not_authenticated');
        return;
      }
      const binding = resolveBinding(url, req, realtime.store);
      if (!binding) {
        rejectUpgrade(socket, 400, 'Bad Request', 'no_binding');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', (error: Error) => {
          realtime.logger.warn(`consumer socket error binding=${binding.id}: ${error.message}`);
        });
        realtime.hub.addSocket(ws, binding.id);
        ws.on('close', () => realtime.hub.removeSocket(ws, binding.id));
        ws.on('message', (data) => {
          void handleConsumerFrame(realtime.hub, realtime.router, ws, binding.id, frameText(data))
            .catch((error: unknown) => {
              realtime.logger.warn(`consumer frame failed binding=${binding.id}: ${String(error)}`);
            });
        });
      });
      return;
    }

    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(deps.config.port, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : deps.config.port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => {
      // An upgraded socket keeps the HTTP server's connection open until it is
      // terminated; without this the close promise never settles.
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}
