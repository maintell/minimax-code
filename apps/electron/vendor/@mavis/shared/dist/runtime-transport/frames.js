/**
 * Runtime transport frame protocol (v2).
 *
 * Carries `Request -> Response` traffic between a renderer-side fetch facade
 * and the local-runtime host living in another process (Electron utility
 * process over MessagePort). The protocol is transport-agnostic: frames are
 * plain structured-clonable objects, so they survive `postMessage` across
 * MessagePort / MessagePortMain / contextBridge boundaries.
 *
 * Design notes (see the utility-process migration proposal):
 * - Client -> server: `request`, `stream-credit`, `abort`.
 * - Server -> client: `response-start`, `stream-chunk`, `stream-done`,
 *   `stream-error`. Every server frame carries the request `id` plus a
 *   monotonically increasing `seq` (response-start is seq 0) used for
 *   dedup, diagnostics and resume boundary checks.
 * - Payloads stay opaque bytes/strings: the first migration phase keeps the
 *   existing SSE `data:` payload format so current parsers work unchanged.
 * - Large files never ride the port: only control frames and small chunks.
 */
export const RUNTIME_TRANSPORT_PROTOCOL_VERSION = 2;
/** Default number of response chunks allowed in flight across the port. */
export const RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW = 16;
/** Trust-boundary cap for one window/credit grant. */
export const RUNTIME_TRANSPORT_MAX_STREAM_WINDOW = 256;
/**
 * Consumer scope for a long-lived runtime stream. Requests that carry
 * different scopes are independent consumers of the same endpoint, so a newer
 * one never supersedes an older one. Same meaning as the `_mavis_stream_scope`
 * query used by event streams; the header form serves generated clients that
 * cannot append query parameters.
 */
export const RUNTIME_TRANSPORT_STREAM_SCOPE_HEADER = 'x-mavis-stream-scope';
/**
 * Adds the stream-scope header to request options when `scope` is set and
 * returns the options unchanged otherwise, so unscoped requests keep their
 * exact shape.
 */
export function withRuntimeTransportStreamScope(options, scope) {
    return scope
        ? { ...options, headers: { [RUNTIME_TRANSPORT_STREAM_SCOPE_HEADER]: scope } }
        : options;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isHeaderMap(value) {
    if (!isRecord(value))
        return false;
    for (const headerValue of Object.values(value)) {
        if (typeof headerValue !== 'string')
            return false;
    }
    return true;
}
function isPayload(value) {
    return typeof value === 'string' || value instanceof Uint8Array;
}
function isSeq(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function isStreamWindow(value) {
    return (typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= RUNTIME_TRANSPORT_MAX_STREAM_WINDOW);
}
/** Validates an untrusted message as a client frame (`request` / `stream-credit` / `abort`). */
export function isRuntimeTransportClientFrame(value) {
    if (!isRecord(value) || !isNonEmptyString(value.id))
        return false;
    switch (value.type) {
        case 'request':
            return (isNonEmptyString(value.method) &&
                isNonEmptyString(value.url) &&
                isHeaderMap(value.headers) &&
                (value.body === undefined || isPayload(value.body)) &&
                (value.streamWindow === undefined || isStreamWindow(value.streamWindow)));
        case 'stream-credit':
            return isStreamWindow(value.credits);
        case 'abort':
            return value.reason === undefined || typeof value.reason === 'string';
        default:
            return false;
    }
}
/** Validates an untrusted message as a server frame (response side). */
export function isRuntimeTransportServerFrame(value) {
    if (!isRecord(value) || !isNonEmptyString(value.id) || !isSeq(value.seq))
        return false;
    switch (value.type) {
        case 'response-start':
            return (typeof value.status === 'number' &&
                Number.isInteger(value.status) &&
                // Response() throws RangeError outside 200-599; reject at the trust
                // boundary instead of letting a malformed frame detonate inside a
                // MessagePort message handler.
                value.status >= 200 &&
                value.status <= 599 &&
                (value.statusText === undefined || typeof value.statusText === 'string') &&
                isHeaderMap(value.headers));
        case 'stream-chunk':
            return isPayload(value.payload);
        case 'stream-done':
            return true;
        case 'stream-error':
            return (typeof value.message === 'string' &&
                (value.code === undefined || typeof value.code === 'string'));
        default:
            return false;
    }
}
//# sourceMappingURL=frames.js.map