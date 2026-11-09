/**
 * On-demand loopback listener for OAuth redirects (plan §5.3).
 *
 * Binds 127.0.0.1 (plus ::1 for `localhost` redirects, best effort), shares one listener per port
 * across attempts, closes when the last attempt releases it, validates the Host header against
 * DNS rebinding, and never echoes query parameters back to the browser.
 */
import { createServer } from 'node:http';
import { settleInBackground } from '../../../infra/async/settle.js';
import { McpOAuthError } from './contracts.js';
const PAGES = {
    success: {
        status: 200,
        title: 'Authorization complete',
        body: 'Authorization complete. You can close this window and return to MiniMax Code.',
    },
    failure: {
        status: 200,
        title: 'Authorization failed',
        body: 'Authorization failed. Return to MiniMax Code for details.',
    },
    invalid: {
        status: 400,
        title: 'Invalid authorization callback',
        body: 'This authorization link is invalid or has expired.',
    },
};
export class LoopbackCallbackServer {
    handler;
    logger;
    listeners = new Map();
    constructor(handler, logger) {
        this.handler = handler;
        this.logger = logger;
    }
    /**
     * Leases a listener on `port` (0 = ephemeral). Throws `MCP_OAUTH_CALLBACK_PORT_IN_USE` when the
     * port is taken by another process; callers decide whether to fall back.
     */
    async listen(options) {
        let listener = options.port === 0 ? undefined : this.listeners.get(options.port);
        if (!listener) {
            const primary = this.createHttpServer();
            const port = await bind(primary, '127.0.0.1', options.port);
            listener = { port, servers: [primary], dualStack: false, leases: 0 };
            this.listeners.set(port, listener);
        }
        if (options.dualStack && !listener.dualStack) {
            listener.dualStack = true;
            const secondary = this.createHttpServer();
            try {
                await bind(secondary, '::1', listener.port);
                listener.servers.push(secondary);
            }
            catch {
                // IPv6 loopback is optional: browsers fall back to 127.0.0.1 for `localhost`.
            }
        }
        listener.leases += 1;
        const leased = listener;
        let released = false;
        return {
            port: leased.port,
            release: () => {
                if (released)
                    return;
                released = true;
                leased.leases -= 1;
                // Graceful: the callback that triggered the release still gets its page.
                if (leased.leases === 0)
                    settleInBackground(this.closeListener(leased, false));
            },
        };
    }
    async close() {
        await Promise.all([...this.listeners.values()].map((listener) => this.closeListener(listener, true)));
    }
    async closeListener(listener, force) {
        if (this.listeners.get(listener.port) === listener)
            this.listeners.delete(listener.port);
        await Promise.all(listener.servers.map((server) => new Promise((resolve) => {
            server.close(() => resolve());
            if (force)
                server.closeAllConnections();
            else
                server.closeIdleConnections();
        })));
    }
    createHttpServer() {
        const server = createServer((req, res) => {
            settleInBackground(this.respond(req, res));
        });
        server.on('error', (error) => {
            this.logger?.warn('MCP OAuth callback listener error', { code: errorCode(error) });
        });
        return server;
    }
    async respond(req, res) {
        try {
            await this.route(req, res);
        }
        catch (error) {
            this.logger?.warn('MCP OAuth callback handling failed', {
                error: error instanceof Error ? error.name : 'unknown',
            });
            if (!res.headersSent)
                writePage(res, 'failure');
        }
    }
    async route(req, res) {
        const listenPort = req.socket.address().port;
        const host = req.headers.host;
        if (req.method !== 'GET' ||
            (host !== `127.0.0.1:${listenPort}` && host !== `localhost:${listenPort}`)) {
            writePage(res, 'invalid');
            return;
        }
        const url = new URL(req.url ?? '/', `http://${host}`);
        writePage(res, await this.handler(url, listenPort));
    }
}
function writePage(res, outcome) {
    const page = PAGES[outcome];
    res.writeHead(page.status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
    });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title></head><body><p>${page.body}</p></body></html>`);
}
function bind(server, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(errorCode(error) === 'EADDRINUSE' || errorCode(error) === 'EACCES'
                ? new McpOAuthError('MCP_OAUTH_CALLBACK_PORT_IN_USE', { cause: error })
                : error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port, host, exclusive: true });
    });
}
function errorCode(error) {
    return error?.code;
}
//# sourceMappingURL=callback-server.js.map