import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
const DEFAULT_REMOTE_ASSET_TIMEOUT_MS = 30_000;
const MAX_REMOTE_ASSET_REDIRECTS = 3;
const NODE_REMOTE_ASSET_TRANSPORT = {
    resolve: async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
        address,
        family: family === 6 ? 6 : 4,
    })),
    request: requestPinnedHttps,
};
export async function readRemoteAssetSource(input) {
    const transport = input.transport ?? NODE_REMOTE_ASSET_TRANSPORT;
    const signal = AbortSignal.timeout(DEFAULT_REMOTE_ASSET_TIMEOUT_MS);
    let current = input.url;
    for (let redirectCount = 0; redirectCount <= MAX_REMOTE_ASSET_REDIRECTS; redirectCount += 1) {
        const { url, addresses } = await requireSafeRemoteAssetUrl(current, transport, signal);
        const response = await requestFirstReachableAddress(transport, url, addresses, signal);
        if (isRedirect(response.statusCode)) {
            const location = responseHeader(response, 'location');
            response.discard();
            if (!location || redirectCount === MAX_REMOTE_ASSET_REDIRECTS) {
                throw new Error('asset_remote_url_invalid');
            }
            try {
                current = new URL(location, url).toString();
            }
            catch {
                throw new Error('asset_remote_url_invalid');
            }
            continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
            response.discard();
            throw new Error('asset_remote_unreadable');
        }
        return {
            buffer: await readBoundedResponseBody(response, input.maxBytes),
            mimeType: responseMimeType(response),
        };
    }
    throw new Error('asset_remote_url_invalid');
}
async function requireSafeRemoteAssetUrl(value, transport, signal) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error('asset_remote_url_invalid');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('asset_remote_url_invalid');
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    if (!hostname || isReservedHostname(hostname))
        throw new Error('asset_remote_url_invalid');
    const literalFamily = isIP(hostname);
    if (literalFamily !== 0) {
        const address = { address: hostname, family: literalFamily === 6 ? 6 : 4 };
        if (!isPublicAddress(address))
            throw new Error('asset_remote_url_invalid');
        return { url, addresses: [address] };
    }
    let addresses;
    try {
        addresses = await withAbort(transport.resolve(hostname), signal);
    }
    catch {
        throw new Error('asset_remote_unreadable');
    }
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
        throw new Error('asset_remote_url_invalid');
    }
    return { url, addresses };
}
async function requestFirstReachableAddress(transport, url, addresses, signal) {
    for (const address of addresses) {
        try {
            return await transport.request({ url, address, signal });
        }
        catch {
            if (signal.aborted)
                break;
        }
    }
    throw new Error('asset_remote_unreadable');
}
function requestPinnedHttps(input) {
    return new Promise((resolve, reject) => {
        const request = httpsRequest(input.url, {
            method: 'GET',
            headers: { accept: '*/*', 'accept-encoding': 'identity' },
            family: input.address.family,
            lookup: pinnedLookup(input.address),
            servername: input.url.hostname.replace(/^\[|\]$/gu, ''),
            signal: input.signal,
        }, (response) => {
            resolve({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                body: response,
                discard: () => response.destroy(),
            });
        });
        request.once('error', reject);
        request.end();
    });
}
function pinnedLookup(address) {
    return ((_hostname, _options, callback) => callback(null, address.address, address.family));
}
async function readBoundedResponseBody(response, maxBytes) {
    const declaredLength = Number(responseHeader(response, 'content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        response.discard();
        throw new Error('asset_too_large');
    }
    const chunks = [];
    let total = 0;
    try {
        for await (const value of response.body) {
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            if (total > maxBytes) {
                response.discard();
                throw new Error('asset_too_large');
            }
            chunks.push(chunk);
        }
    }
    catch (error) {
        if (error instanceof Error && error.message === 'asset_too_large')
            throw error;
        response.discard();
        throw new Error('asset_remote_unreadable');
    }
    return Buffer.concat(chunks, total);
}
function responseMimeType(response) {
    return responseHeader(response, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() || '';
}
function responseHeader(response, name) {
    const value = response.headers[name];
    return typeof value === 'string' ? value : value?.[0];
}
function isRedirect(status) {
    return [301, 302, 303, 307, 308].includes(status);
}
function isReservedHostname(hostname) {
    return (hostname === 'localhost' ||
        !hostname.includes('.') ||
        ['.localhost', '.local', '.internal', '.home.arpa', '.test', '.example', '.invalid'].some((suffix) => hostname.endsWith(suffix)));
}
function isPublicAddress(input) {
    return input.family === 4 ? isPublicIpv4(input.address) : isPublicIpv6(input.address);
}
function isPublicIpv4(address) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 ||
        octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return false;
    }
    const [first = 0, second = 0, third = 0] = octets;
    if (first === 0 || first === 10 || first === 127 || first >= 224)
        return false;
    if (first === 100 && second >= 64 && second <= 127)
        return false;
    if (first === 169 && second === 254)
        return false;
    if (first === 172 && second >= 16 && second <= 31)
        return false;
    if (first === 192 && second === 168)
        return false;
    if (first === 192 && second === 0 && [0, 2].includes(third))
        return false;
    if (first === 198 && [18, 19, 51].includes(second))
        return false;
    if (first === 203 && second === 0 && third === 113)
        return false;
    return true;
}
function isPublicIpv6(address) {
    const normalized = address.toLowerCase();
    return !(normalized === '::' ||
        normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        /^fe[89ab]/u.test(normalized) ||
        normalized.startsWith('ff') ||
        normalized.startsWith('2001:db8:') ||
        normalized.startsWith('::ffff:'));
}
function withAbort(operation, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then((value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
        });
    });
}
//# sourceMappingURL=remote-source.js.map