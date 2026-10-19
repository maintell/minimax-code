import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { AuthLeaseFrameDecoder, encodeAuthLeaseFrame } from './codec.js';
import { AuthLeaseProtocolError, createAuthLeaseFailureResponse, createAuthLeaseSuccessResponse, parseAuthLeaseRequest, } from './contracts.js';
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_MAX_REQUESTS_PER_CONNECTION = 256;
export async function startNodeAuthLeaseServer(options) {
    const capabilityBytes = Buffer.from(options.capability, 'utf8');
    if (!/^[A-Za-z0-9_-]{43}$/u.test(options.capability)) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    const idleTimeoutMs = requirePositiveInteger(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
    const maxConnections = requirePositiveInteger(options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    const maxRequestsPerConnection = requirePositiveInteger(options.maxRequestsPerConnection ?? DEFAULT_MAX_REQUESTS_PER_CONNECTION);
    const isPipe = options.endpoint.startsWith('\\\\.\\pipe\\');
    if (!isPipe) {
        await mkdir(path.dirname(options.endpoint), { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32')
            await chmod(path.dirname(options.endpoint), 0o700);
        await rm(options.endpoint, { force: true });
    }
    const sockets = new Set();
    let accepting = true;
    let closed = false;
    const server = net.createServer((socket) => {
        if (!accepting || sockets.size >= maxConnections) {
            socket.destroy();
            return;
        }
        sockets.add(socket);
        socket.setTimeout(idleTimeoutMs, () => socket.destroy());
        const decoder = new AuthLeaseFrameDecoder();
        let requestCount = 0;
        socket.on('data', (chunk) => {
            let frames;
            try {
                frames = decoder.push(chunk);
            }
            catch {
                socket.destroy();
                return;
            }
            for (const frame of frames) {
                requestCount += 1;
                if (requestCount > maxRequestsPerConnection) {
                    socket.destroy();
                    return;
                }
                void handleFrame(frame, socket, capabilityBytes, options.handler);
            }
        });
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
    });
    await listen(server, options.endpoint);
    if (!isPipe && process.platform !== 'win32')
        await chmod(options.endpoint, 0o600);
    return {
        async close() {
            if (closed)
                return;
            closed = true;
            accepting = false;
            for (const socket of sockets)
                socket.destroy();
            await closeServer(server);
            if (!isPipe)
                await rm(options.endpoint, { force: true });
        },
    };
}
async function handleFrame(frame, socket, expectedCapability, handler) {
    const requestId = extractRequestId(frame);
    try {
        const request = parseAuthLeaseRequest(frame);
        if (!matchesCapability(request.capability, expectedCapability)) {
            throw new AuthLeaseProtocolError('CAPABILITY_REJECTED');
        }
        const result = await handler(request);
        writeResponse(socket, createAuthLeaseSuccessResponse(request.requestId, result));
    }
    catch (error) {
        if (!requestId) {
            socket.destroy();
            return;
        }
        writeResponse(socket, createAuthLeaseFailureResponse(requestId, error));
    }
}
function matchesCapability(value, expected) {
    const received = Buffer.from(value, 'utf8');
    return received.length === expected.length && timingSafeEqual(received, expected);
}
function extractRequestId(frame) {
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame))
        return undefined;
    const requestId = frame.requestId;
    if (typeof requestId !== 'string' ||
        requestId.length === 0 ||
        requestId.length > 128 ||
        !/^[A-Za-z0-9._:-]+$/u.test(requestId)) {
        return undefined;
    }
    return requestId;
}
function writeResponse(socket, response) {
    if (!socket.destroyed && socket.writable)
        socket.write(encodeAuthLeaseFrame(response));
}
function requirePositiveInteger(value) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return value;
}
function listen(server, endpoint) {
    return new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(endpoint);
    });
}
function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
//# sourceMappingURL=node-server.js.map