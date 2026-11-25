import { lookup } from 'node:dns/promises';
import { connect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
const PROBE_TIMEOUT_MS = 3_000;
/**
 * How long a HEAD may take before the endpoint counts as unreachable. A
 * degraded link still answers, only slowly: requests on one took 10 to 20
 * seconds while the service stayed up. Within this budget a slow answer is
 * online and keeps the bounded retries; only a link that gives no answer at
 * all is waited out as offline.
 */
const FETCH_PROBE_TIMEOUT_MS = 15_000;
/** Connect failures that mean no route to the endpoint, not a refusing endpoint. */
const UNREACHABLE_CONNECT_CODES = new Set([
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
    'EADDRNOTAVAIL',
    'ETIMEDOUT',
]);
/**
 * Transport errors that still mean the endpoint answered. Chromium names
 * ERR_CONNECTION_REFUSED only for the endpoint itself. Chromium rejects a 3xx
 * with an invalid Location as ERR_INVALID_REDIRECT before the host fetch can
 * return it, which is still an HTTP answer from the endpoint. Electron's net
 * fails a 3xx with "Redirect was cancelled" when the host fetch does not return
 * a manual redirect; kept as a fallback for such a host fetch.
 */
const ENDPOINT_ANSWERED_MESSAGE = /ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_INVALID_REDIRECT|Redirect was cancelled/u;
/**
 * Whether any non-loopback interface holds a routable address. Link-local
 * addresses (169.254/16, fe80::/10) appear while a link is still negotiating
 * and do not count. A device with such an interface is online as far as this
 * module can tell, even when one gateway does not answer.
 */
export function hasRoutableNetworkInterface(interfaces = networkInterfaces()) {
    return Object.values(interfaces).some((addresses) => (addresses ?? []).some((address) => !address.internal && !isLinkLocal(address.address)));
}
function isLinkLocal(address) {
    return address.startsWith('169.254.') || /^fe[89ab]/iu.test(address);
}
export function networkEndpoint(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    }
    catch {
        return undefined;
    }
    const host = url.hostname.replace(/^\[|\]$/gu, '');
    if (!host || (url.protocol !== 'http:' && url.protocol !== 'https:'))
        return undefined;
    return {
        origin: url.origin,
        host,
        port: url.port ? Number(url.port) : defaultPort(url.protocol),
    };
}
function defaultPort(protocol) {
    return protocol === 'http:' ? 80 : 443;
}
/**
 * Probe with the fetch the runtime's own requests use, so the probe takes
 * their route: Chromium's network stack in Desktop (system proxy, PAC, TUN,
 * VPN, read live), the environment proxy dispatcher in the TUI. Any HTTP
 * answer, whatever its status (a redirect included), means the endpoint is reachable. A connection
 * the endpoint refuses means the device reached it and the endpoint itself is
 * down; a refusing proxy port means the route is down. Any other transport
 * failure, or no answer in time, means offline.
 */
export function createFetchConnectivityProbe(fetchImpl) {
    return async (endpoint, signal) => {
        // A cancelled caller no longer needs a verdict; online keeps it out of any wait.
        if (signal?.aborted)
            return 'online';
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), FETCH_PROBE_TIMEOUT_MS);
        try {
            // A HEAD answer carries no body to drain.
            await fetchImpl(endpoint.origin, {
                method: 'HEAD',
                redirect: 'manual',
                signal: controller.signal,
            });
            return 'online';
        }
        catch (error) {
            if (signal?.aborted)
                return 'online';
            return (await endpointAnswered(error, endpoint)) ? 'online' : 'offline';
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    };
}
/**
 * Node reports ECONNREFUSED with the refused address and port on the error or
 * its cause. The endpoint refused only when that socket is the endpoint's own:
 * an environment proxy that is not running refuses from its own address, which
 * may share the endpoint's port. Chromium reports a refusing proxy as
 * ERR_PROXY_CONNECTION_FAILED.
 */
async function endpointAnswered(error, endpoint) {
    const answer = findEndpointAnswer(error);
    if (answer === undefined || answer === true)
        return answer === true;
    for (const socket of answer) {
        if (await isEndpointSocket(socket, endpoint))
            return true;
    }
    return false;
}
async function isEndpointSocket(socket, endpoint) {
    if (typeof socket.port === 'number' && socket.port !== endpoint.port)
        return false;
    if (typeof socket.address !== 'string')
        return true;
    return isEndpointAddress(socket.address, endpoint.host);
}
/**
 * A connection over several addresses fails as an AggregateError whose own
 * code is ECONNREFUSED while each refused socket is one of its `errors`.
 */
function refusedSockets(error) {
    const { errors } = error;
    if (!Array.isArray(errors) || errors.length === 0)
        return [error];
    return errors.filter((child) => child?.code === 'ECONNREFUSED');
}
function findEndpointAnswer(error) {
    for (let current = error, depth = 0; current && depth < 4; depth += 1) {
        const { code, message, cause } = current;
        if (code === 'ECONNREFUSED')
            return refusedSockets(current);
        if (typeof message === 'string' && ENDPOINT_ANSWERED_MESSAGE.test(message))
            return true;
        current = cause;
    }
    return undefined;
}
async function isEndpointAddress(address, host) {
    if (isIP(host))
        return address === host;
    try {
        const resolved = await withTimeout(lookup(host, { all: true }), PROBE_TIMEOUT_MS);
        return resolved.some((entry) => entry.address === address);
    }
    catch {
        // A direct connect needs the name to resolve; the refusal came from elsewhere.
        return false;
    }
}
/**
 * Fallback for a host that supplies no fetch: resolve the endpoint, then open
 * one direct TCP connection to it. A failed lookup or an unreachable route
 * means offline; a connection that opens or is refused means the device is
 * online and the endpoint itself is the problem.
 */
export async function probeEndpointConnectivity(endpoint, signal) {
    let address;
    try {
        ({ address } = await withTimeout(lookup(endpoint.host), PROBE_TIMEOUT_MS));
    }
    catch {
        return 'offline';
    }
    return connectOnce(address, endpoint.port, signal);
}
function connectOnce(address, port, signal) {
    return new Promise((resolve) => {
        // A cancelled caller no longer needs a verdict; online keeps it out of any wait.
        if (signal?.aborted) {
            resolve('online');
            return;
        }
        const socket = connect({ host: address, port, timeout: PROBE_TIMEOUT_MS });
        const finish = (result) => {
            signal?.removeEventListener('abort', onAbort);
            socket.destroy();
            resolve(result);
        };
        const onAbort = () => finish('online');
        signal?.addEventListener('abort', onAbort, { once: true });
        socket.once('connect', () => finish('online'));
        socket.once('timeout', () => finish('offline'));
        socket.once('error', (error) => {
            finish(error.code && UNREACHABLE_CONNECT_CODES.has(error.code) ? 'offline' : 'online');
        });
    });
}
async function withTimeout(pending, ms) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('connectivity probe timed out')), ms);
    });
    try {
        return await Promise.race([pending, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=connectivity-probe.adapter.js.map