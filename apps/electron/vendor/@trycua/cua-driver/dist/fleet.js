/** Node-only composition of an existing Fleet client and the shared Rust Driver. */
import { randomUUID } from 'node:crypto';
import { openMcpDriverChannel, DriverServiceTransportError, } from './index.js';
const FLEET_DRIVER_MAX_RESPONSE_BYTES = 16n * 1024n * 1024n;
/**
 * Connect to an advertised service on the caller's live Fleet claim.
 * The caller owns the client and claim, and must await close before releasing
 * either. Abort closes this connection; it does not undo desktop actions.
 */
export async function connectFleetDriver({ client, sandbox, service = 'mcp', signal, }) {
    const target = {
        namespace: sandbox.namespace,
        claim: sandbox.claim,
        name: sandbox.name,
        services: [...sandbox.services],
    };
    if (!target.services.includes(service)) {
        throw new Error('Fleet sandbox does not advertise the requested Driver service');
    }
    if (signal?.aborted)
        throw new Error('Fleet Driver connection aborted');
    const serviceRequest = client.serviceRequest.bind(client);
    let closing;
    async function send(request) {
        // Keep routing authority in Fleet even if the native boundary changes.
        if (!request.path.startsWith('/') ||
            request.path.length > 2048 ||
            request.path.startsWith('//') ||
            /[\\?#\s%]/u.test(request.path) ||
            request.path.split('/').some((part) => part === '.' || part === '..') ||
            request.timeoutMs <= 0n ||
            request.timeoutMs > 2147483647n) {
            throw new DriverServiceTransportError.Failed({
                reason: 'Invalid bounded Driver service request',
            });
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Number(request.timeoutMs));
        let onAbort = () => { };
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(new Error('Fleet Driver service request canceled'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            const response = await Promise.race([
                serviceRequest({ ...target, services: [...target.services] }, service, request.path, {
                    method: request.method,
                    url: `https://service.invalid${request.path}`,
                    headers: request.headers.map((header) => ({ ...header })),
                    body: request.body,
                    timeoutSecs: (request.timeoutMs + 999n) / 1000n,
                    maxResponseBytes: FLEET_DRIVER_MAX_RESPONSE_BYTES,
                }, { signal: controller.signal }),
                aborted,
            ]);
            if (BigInt(response.body.byteLength) > FLEET_DRIVER_MAX_RESPONSE_BYTES) {
                throw new Error('Fleet Driver response exceeds the configured size limit');
            }
            return response;
        }
        catch {
            // Native callback errors must not expose Fleet credentials or response bodies.
            throw new DriverServiceTransportError.Failed({
                reason: 'Fleet Driver service request failed',
            });
        }
        finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', onAbort);
        }
    }
    const channel = openMcpDriverChannel({ send }, `fleet:${randomUUID()}`);
    const close = () => {
        if (!closing) {
            signal?.removeEventListener('abort', onAbort);
            // Retain the promise so cancellation cannot orphan cleanup or hide errors
            // from a later explicit close. Rust bounds its own session teardown.
            closing = channel.close();
        }
        return closing;
    };
    const onAbort = () => {
        void close().catch(() => { });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        if (signal?.aborted)
            throw new Error('Fleet Driver connection aborted');
        await channel.open();
        if (signal?.aborted || closing)
            throw new Error('Fleet Driver connection aborted');
        return Object.freeze({ driver: channel.driver(), sessionName: channel.publicSession(), close });
    }
    catch (error) {
        await close();
        throw error;
    }
}
