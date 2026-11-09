import { createServer } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PptPreviewError } from '@mavis/shared/ppt-preview';
/** A task-owned loopback bridge in the existing runtime process; no second Runtime or default port. */
export class PptPreviewTaskConnection {
    dataDir;
    execute;
    server;
    opening;
    leases = new Map();
    sockets = new Set();
    closed = false;
    responses = new Map();
    constructor(dataDir, execute) {
        this.dataDir = dataDir;
        this.execute = execute;
    }
    async issue(sessionId, origin) {
        if (this.closed)
            throw new Error('PPT task connection closed');
        const existing = [...this.leases.values()].find((lease) => lease.sessionId === sessionId && lease.origin?.turnId === origin?.turnId);
        if (existing)
            return {
                connectionFile: existing.file,
                cliPath: fileURLToPath(new URL('./ppt-preview-cli.js', import.meta.url)),
            };
        const port = await this.listen();
        const token = randomBytes(32).toString('hex');
        const folder = join(this.dataDir, 'v2', 'ppt-preview', 'connections');
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const file = join(folder, `${randomUUID()}.json`);
        await writeFile(file, JSON.stringify({
            schema: 'minimax.ppt-preview.connection.v1',
            host: '127.0.0.1',
            port,
            token,
        }), { flag: 'wx', mode: 0o600 });
        this.leases.set(token, { sessionId, file, origin });
        return {
            connectionFile: file,
            cliPath: fileURLToPath(new URL('./ppt-preview-cli.js', import.meta.url)),
        };
    }
    listen() {
        if (this.opening)
            return this.opening;
        this.opening = new Promise((resolve, reject) => {
            const server = createServer((socket) => this.accept(socket));
            this.server = server;
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                const address = server.address();
                if (!address || typeof address === 'string') {
                    reject(new Error('PPT task connection has no address'));
                    return;
                }
                resolve(address.port);
            });
        });
        return this.opening;
    }
    accept(socket) {
        this.sockets.add(socket);
        socket.once('close', () => this.sockets.delete(socket));
        socket.on('error', () => socket.destroy());
        socket.setTimeout(30_000, () => socket.destroy());
        let text = '';
        let receivedBytes = 0;
        const decoder = new StringDecoder('utf8');
        let finished = false;
        socket.on('data', (bytes) => {
            if (finished)
                return;
            receivedBytes += bytes.length;
            text += decoder.write(bytes);
            if (receivedBytes > 256 * 1024) {
                finished = true;
                socket.destroy();
                return;
            }
            if (!text.includes('\n'))
                return;
            finished = true;
            socket.pause();
            this.responses.set(socket, this.respond(socket, text));
        });
    }
    async respond(socket, text) {
        try {
            const result = await this.dispatch(text);
            socket.end(`${JSON.stringify({ ok: true, result })}\n`);
        }
        catch (error) {
            socket.end(`${JSON.stringify({
                ok: false,
                error: {
                    code: error instanceof PptPreviewError ? error.code : 'REQUEST_FAILED',
                    message: error instanceof Error ? error.message : 'PPT request failed',
                },
            })}\n`);
        }
        finally {
            this.responses.delete(socket);
        }
    }
    async dispatch(text) {
        const input = JSON.parse(text.slice(0, text.indexOf('\n')));
        const token = typeof input.token === 'string' ? input.token : '';
        const lease = [...this.leases.entries()].find(([expected]) => token.length === expected.length &&
            timingSafeEqual(Buffer.from(token), Buffer.from(expected)))?.[1];
        if (!lease || this.closed)
            throw new PptPreviewError('FILE_NOT_AUTHORIZED', 'PPT task connection expired or unauthorized');
        return this.execute(lease.sessionId, input.request, lease.origin);
    }
    async close() {
        this.closed = true;
        for (const socket of this.sockets)
            socket.destroy();
        if (this.server)
            await new Promise((resolve) => this.server.close(() => resolve()));
        await Promise.all([...this.leases.values()].map((lease) => rm(lease.file, { force: true })));
        this.leases.clear();
        await Promise.allSettled([...this.responses.values()]);
        this.responses.clear();
    }
}
//# sourceMappingURL=task-connection.adapter.js.map