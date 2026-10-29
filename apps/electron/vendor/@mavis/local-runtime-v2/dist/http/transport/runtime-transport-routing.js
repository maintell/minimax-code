/** Runtime-path admission and long-lived stream identity for the MessagePort host. */
import { RUNTIME_TRANSPORT_STREAM_SCOPE_HEADER, } from '@mavis/shared/runtime-transport';
const SYNTHETIC_ORIGIN = 'http://local-runtime.transport';
const CLOUD_ALIAS_PREFIX = '/archon/api/v1/';
const MAVIS_API_PREFIX = '/mavis/';
const DESKTOP_API_PREFIX = '/minimax-desktop/api/';
const EVENTS_PATH = '/minimax-desktop/api/v1/events';
const STREAM_SCOPE_QUERY = '_mavis_stream_scope';
const STREAM_SCOPE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const STREAMING_SUFFIXES = ['/message', '/resume'];
const SESSION_STREAM_PREFIXES = ['/mavis/api/session/', '/minimax-desktop/api/v1/session/'];
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
/**
 * Rebases a frame URL onto the synthetic origin, applies the Electron-local
 * cloud alias, and rejects paths that do not belong to the local runtime.
 */
export function resolveRuntimeTransportUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl, SYNTHETIC_ORIGIN);
    }
    catch {
        return null;
    }
    const target = new URL(`${url.pathname}${url.search}`, SYNTHETIC_ORIGIN);
    const decodedPath = safeDecode(target.pathname);
    if (decodedPath.startsWith(CLOUD_ALIAS_PREFIX)) {
        target.pathname = `/mavis/api/${decodedPath.slice(CLOUD_ALIAS_PREFIX.length)}`;
        return target;
    }
    if (decodedPath.startsWith(MAVIS_API_PREFIX) || decodedPath.startsWith(DESKTOP_API_PREFIX)) {
        return target;
    }
    return null;
}
export function isGlobalEventStreamUrl(url) {
    return safeDecode(url.pathname) === EVENTS_PATH;
}
/**
 * Single-flight identity of a long-lived stream. Requests with the same key
 * replace each other; a consumer scope (query or header) makes a separate
 * consumer of the same endpoint. An absent or invalid scope keeps the shared
 * endpoint claim.
 */
export function runtimeTransportStreamKey(method, url, headers) {
    const normalizedMethod = method.toUpperCase();
    const pathname = safeDecode(url.pathname);
    const endpoint = `${normalizedMethod} ${pathname}`;
    if (pathname === EVENTS_PATH)
        return scopedStreamKey(endpoint, requestedStreamScope(url, headers));
    if (normalizedMethod !== 'POST' ||
        !SESSION_STREAM_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
        return null;
    }
    return STREAMING_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
        ? scopedStreamKey(endpoint, requestedStreamScope(url, headers))
        : null;
}
function scopedStreamKey(endpoint, scope) {
    return scope ? `${endpoint}\u0000${scope}` : endpoint;
}
function requestedStreamScope(url, headers) {
    const requested = (url.searchParams.get(STREAM_SCOPE_QUERY) ??
        headerValue(headers, RUNTIME_TRANSPORT_STREAM_SCOPE_HEADER))
        ?.trim()
        .toLowerCase();
    return requested && STREAM_SCOPE_PATTERN.test(requested) ? requested : null;
}
function headerValue(headers, name) {
    if (!headers)
        return undefined;
    for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === name)
            return value;
    }
    return undefined;
}
//# sourceMappingURL=runtime-transport-routing.js.map