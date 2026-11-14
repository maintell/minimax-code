import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
const DEFAULT_LOOKUP_TIMEOUT_MS = 300;
const DEFAULT_DNS_CACHE_TTL_MS = 60_000;
/**
 * Reserved names that can only mean this machine or a private network. Matching
 * them needs no DNS round trip, so they stay decidable offline.
 */
const RESERVED_HOST_SUFFIXES = ['.local', '.internal', '.lan', '.corp', '.home.arpa'];
const RESERVED_HOSTS = new Set(['localhost']);
export class IntranetGuard {
    isLearnedIntranetHost;
    lookupTimeoutMs;
    dnsCacheTtlMs;
    lookupImpl;
    now;
    dnsCache = new Map();
    constructor(options = {}) {
        this.isLearnedIntranetHost = options.isLearnedIntranetHost ?? (() => false);
        this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
        this.dnsCacheTtlMs = options.dnsCacheTtlMs ?? DEFAULT_DNS_CACHE_TTL_MS;
        this.lookupImpl = options.lookupImpl ?? lookupAllAddresses;
        this.now = options.now ?? Date.now;
    }
    async classify(url) {
        const parsed = parseHttpUrl(url);
        // An unparseable or credentialed URL is never forwarded; the local client
        // owns the user-facing error for it.
        if (!parsed || parsed.username || parsed.password)
            return 'literal';
        const host = normalizeHostname(parsed.hostname);
        if (!host)
            return 'literal';
        const literalIp = classifyIpLiteral(host);
        if (literalIp)
            return literalIp;
        if (isReservedHost(host))
            return 'literal';
        if (this.isLearnedIntranetHost(host))
            return 'learned';
        return this.classifyByDns(host);
    }
    async classifyByDns(host) {
        const cached = this.dnsCache.get(host);
        if (cached && cached.expiresAtMs > this.now())
            return cached.classification;
        const classification = await this.resolveDnsClassification(host);
        // A resolver failure says nothing lasting about the host (VPN DNS may be
        // reconnecting), so it is decided again on the next fetch.
        if (classification === 'dns_error')
            return classification;
        this.dnsCache.set(host, {
            classification,
            expiresAtMs: this.now() + this.dnsCacheTtlMs,
        });
        return classification;
    }
    async resolveDnsClassification(host) {
        let addresses;
        try {
            addresses = await withTimeout(this.lookupImpl(host), this.lookupTimeoutMs);
        }
        catch (error) {
            // A name that does not resolve is never forwarded: it is a private or
            // VPN-only name as far as this device is concerned.
            if (isNotFoundError(error))
                return 'dns_notfound';
            // A slow or broken resolver cannot vouch for the host being public. The
            // fetch still happens, on this device.
            return 'dns_error';
        }
        if (addresses.length === 0)
            return 'dns_notfound';
        return addresses.some((address) => isPrivateAddress(address)) ? 'dns' : 'forwardable';
    }
}
/** The host of an HTTP(S) URL in the form the guard and the learned list use. */
export function intranetHostOf(url) {
    const parsed = parseHttpUrl(url);
    return parsed ? normalizeHostname(parsed.hostname) || undefined : undefined;
}
function parseHttpUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        return url;
    }
    catch {
        return undefined;
    }
}
function normalizeHostname(hostname) {
    // `URL` keeps IPv6 literals bracketed; the classifier works on bare addresses.
    const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return unbracketed.toLowerCase().replace(/\.$/u, '');
}
function classifyIpLiteral(host) {
    if (isIP(host) === 0)
        return undefined;
    return isPrivateAddress(host) ? 'literal' : 'forwardable';
}
function isReservedHost(host) {
    if (RESERVED_HOSTS.has(host))
        return true;
    if (RESERVED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)))
        return true;
    // A single-label name can only be resolved through this machine's own search
    // domains, so it is intranet by construction.
    return !host.includes('.');
}
/**
 * Private and local-only ranges. 198.18.0.0/15 is deliberately excluded:
 * Clash/Surge fake-ip mode resolves every domain into it, so treating it as
 * private would forward nothing at all.
 * @internal Exported only for focused tests.
 */
export function isPrivateAddress(address) {
    const unwrapped = unwrapMappedAddress(address.trim().toLowerCase());
    return isIP(unwrapped) === 4 ? isPrivateIpv4(unwrapped) : isPrivateIpv6(unwrapped);
}
/**
 * `::ffff:a.b.c.d` carries an IPv4 address; classify the address it wraps.
 * `URL` canonicalises the dotted form to hex (`::ffff:c0a8:5`), so both spellings
 * have to be unwrapped.
 */
function unwrapMappedAddress(address) {
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(address);
    if (dotted?.[1])
        return dotted[1];
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
    if (!hex?.[1] || !hex[2])
        return address;
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}
/**
 * Private and local-only IPv4 ranges. Each predicate is a single range so the
 * list stays readable as the reserved space grows.
 */
const PRIVATE_IPV4_RANGES = [
    (o) => o[0] === 0,
    (o) => o[0] === 10,
    (o) => o[0] === 127,
    (o) => o[0] === 169 && o[1] === 254,
    (o) => o[0] === 172 && inRange(o[1], 16, 31),
    (o) => o[0] === 192 && o[1] === 168,
    (o) => o[0] === 100 && inRange(o[1], 64, 127),
];
function isPrivateIpv4(address) {
    const octets = address.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet)))
        return true;
    return PRIVATE_IPV4_RANGES.some((matches) => matches(octets));
}
function inRange(value, min, max) {
    return value !== undefined && value >= min && value <= max;
}
function isPrivateIpv6(address) {
    if (address === '::' || address === '::1')
        return true;
    if (/^f[cd][0-9a-f]{2}:/u.test(address))
        return true;
    if (/^fe[89ab][0-9a-f]:/u.test(address))
        return true;
    return false;
}
async function lookupAllAddresses(hostname) {
    const records = await lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
}
function isNotFoundError(error) {
    const code = error?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA')
        return true;
    const message = error instanceof Error ? error.message : '';
    return /\bENOTFOUND\b/u.test(message);
}
async function withTimeout(operation, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('dns lookup timed out')), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=intranet-guard.js.map