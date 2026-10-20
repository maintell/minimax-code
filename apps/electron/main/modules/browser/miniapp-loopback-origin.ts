const MAX_LOOPBACK_ORIGIN_LENGTH = 128;
const MIN_LOOPBACK_PORT = 1;
const MAX_LOOPBACK_PORT = 65535;
/**
 * Single parser for the `http://127.0.0.1:<port>` origin every Mini App loopback
 * surface must agree on: exact scheme, exact loopback hostname, an explicit port,
 * and no path/query/hash/credentials. Callers that need extra checks (URL
 * resolution, request-origin matching) build on this shared result instead of
 * re-deriving the same `new URL(...)` validation.
 */
export function parseMiniAppLoopbackOrigin(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_LOOPBACK_ORIGIN_LENGTH) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port) {
        return null;
    }
    // `URL#origin` drops userinfo, path, query, and hash; an exact match back to
    // the input proves none of those were present.
    if (parsed.origin !== value)
        return null;
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < MIN_LOOPBACK_PORT || port > MAX_LOOPBACK_PORT) {
        return null;
    }
    return { origin: parsed.origin, port };
}
