/**
 * Safe classifier for the log lines `@larksuiteoapi/node-sdk`'s `WSClient`
 * writes into the logger we inject.
 *
 * Why this exists: the SDK reports every long-connection failure only as
 * free text (`[ws] connect failed`, `[ws] Request failed with status code
 * 403`, ...). That text must never reach our logs — the same channel also
 * carries the endpoint URL with its connection ticket (`get connect config
 * success, ws url: ...`), inbound message bodies (`receive message ...
 * data: ...`) and server-provided `msg` strings. So instead of forwarding
 * text we reduce a line to a fixed category plus the few scalars that make
 * it actionable: the endpoint business code, the HTTP status, a whitelisted
 * Node errno token and the SDK retry counter. Nothing else from the input
 * can reach the output.
 *
 * Phrases are pinned to SDK 1.60.0 (`lib/index.js`, `class WSClient`). A
 * reworded phrase in a future SDK degrades to `unknown` — never to leaking
 * text — so an upgrade can lose precision but not safety.
 */
const ENDPOINT_CODE_NAMES = new Map([
    [0, 'ok'],
    [1, 'system_busy'],
    [403, 'forbidden'],
    [514, 'auth_failed'],
    [1000040343, 'internal_error'],
    [1000040350, 'exceed_conn_limit'],
]);
/**
 * The only errno tokens ever copied out of SDK text. Anything else (host
 * names, IPs, ports, OpenSSL detail) stays behind.
 */
const ERRNO_WHITELIST = [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
    'EPROTO',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID',
];
const ERRNO_TOKEN_RE = new RegExp(`\\b(${ERRNO_WHITELIST.join('|')})\\b`);
/**
 * Node/OpenSSL render these failures WITHOUT the errno token in `message`,
 * and axios forwards only `message` (which is all the SDK logs). Without
 * this table the TLS entries of the whitelist could never match — and a
 * corporate MITM proxy certificate is a prime suspect for "bot bound but
 * the long connection never comes up". Order matters: the chain variant
 * must win over the bare self-signed phrase.
 */
const ERRNO_BY_PHRASE = [
    [/self[- ]signed certificate in certificate chain/i, 'SELF_SIGNED_CERT_IN_CHAIN'],
    [/self[- ]signed certificate/i, 'DEPTH_ZERO_SELF_SIGNED_CERT'],
    [/certificate has expired/i, 'CERT_HAS_EXPIRED'],
    [/unable to verify the first certificate/i, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'],
    [/does not match certificate's altnames/i, 'ERR_TLS_CERT_ALTNAME_INVALID'],
    [/socket hang up/i, 'ECONNRESET'],
];
/** Whole-body SDK phrases (after the `[ws]` tag is stripped). */
const EXACT_PHRASES = new Map([
    ['connect failed', 'connect_failed'],
    ['ws connect failed', 'ws_handshake_failed'],
    ['new WebSocket error', 'ws_construct_failed'],
    ['ws error', 'ws_runtime_error'],
    ['send data failed', 'send_failed'],
    ['appId is needed', 'credential_missing'],
    ['appSecret is needed', 'credential_missing'],
    ['client need to start with a eventDispatcher', 'event_dispatcher_missing'],
    ['system busy', 'endpoint_request_failed'],
]);
/**
 * Ordered prefix / pattern rules for lines that embed variable data. Every
 * rule is anchored on an SDK (or axios) phrase so digits elsewhere in a
 * line can never be mistaken for a code. The matchers are hoisted function
 * declarations further down.
 */
const PATTERN_RULES = [
    // The tail is OUR handler's error text (it can echo anything, including
    // numbers that look like codes) — classify by prefix, extract nothing.
    (body) => body.startsWith('invoke event failed') ? { category: 'event_handler_failed' } : undefined,
    matchEndpointCode,
    matchHttpStatus,
    (body) => (/^timeout of \d+ms exceeded/.test(body) ? { category: 'network_timeout' } : undefined),
    matchRetryCount,
    matchErrno,
    (body) => /^Cannot (?:read|destructure) propert/.test(body)
        ? { category: 'endpoint_response_invalid' }
        : undefined,
];
/**
 * Flatten + render an SDK logger call. SDK 1.60.0's `LoggerProxy` calls
 * `logger.error(msg)` with its rest-args ARRAY as the single argument,
 * while hand-written callers (and older tests) pass the parts spread —
 * accept both by flattening one level, which covers either shape.
 */
export function renderFeishuSdkMessage(args) {
    const parts = args.flatMap((arg) => Array.isArray(arg) ? arg.map(renderPart) : [renderPart(arg)]);
    const text = parts.join(' ');
    // `[ws]` on most lines, bare `ws` on the reconnect-loop line; other SDK
    // units (constructor asserts, DataCache) log without a tag.
    const untagged = parts[0] === '[ws]' || parts[0] === 'ws' ? parts.slice(1) : parts;
    return { text, body: untagged.join(' ').trim() };
}
/**
 * Classify one SDK logger call into a {@link FeishuSdkMessageSummary}.
 * Pure; accepts both the array-arg and the spread-arg call shape.
 */
export function summarizeFeishuSdkMessage(args) {
    const { body } = renderFeishuSdkMessage(args);
    const exact = EXACT_PHRASES.get(body);
    if (exact)
        return { category: exact };
    for (const rule of PATTERN_RULES) {
        const summary = rule(body);
        if (summary)
            return summary;
    }
    // Unrecognised text is reported by category only — never echoed.
    return { category: 'unknown' };
}
function renderPart(part) {
    if (typeof part === 'string')
        return part;
    if (part instanceof Error)
        return part.message;
    try {
        return JSON.stringify(part) ?? String(part);
    }
    catch {
        // Circular / BigInt payloads cannot be JSON-encoded; String() still gives
        // phrase matching something to look at (the result is never logged).
        return String(part);
    }
}
/** `code: ${code}, ...` — the SDK's non-ok endpoint reply line. */
function matchEndpointCode(body) {
    const match = /^code:\s*(-?\d+)?/.exec(body);
    if (!match)
        return undefined;
    // `code: undefined` (reply without a code field) still means "endpoint
    // rejected"; only the number is omitted.
    const code = parseSafeInteger(match[1]);
    if (code === undefined)
        return { category: 'endpoint_rejected' };
    const codeName = ENDPOINT_CODE_NAMES.get(code);
    return { category: 'endpoint_rejected', code, ...(codeName ? { codeName } : {}) };
}
function matchHttpStatus(body) {
    const match = /^Request failed with status code (\d{3})\b/.exec(body);
    const httpStatus = parseSafeInteger(match?.[1]);
    return httpStatus === undefined ? undefined : { category: 'http_error', httpStatus };
}
function matchRetryCount(body) {
    const match = /^unable to connect to the server after trying (\d+) times/.exec(body);
    const retryCount = parseSafeInteger(match?.[1]);
    return retryCount === undefined ? undefined : { category: 'reconnect_failed', retryCount };
}
function matchErrno(body) {
    const token = ERRNO_TOKEN_RE.exec(body)?.[1];
    // Re-resolve through the whitelist so the output is the constant itself,
    // never a slice of the input string.
    const literal = ERRNO_WHITELIST.find((candidate) => candidate === token);
    if (literal)
        return { category: 'network_error', errno: literal };
    const byPhrase = ERRNO_BY_PHRASE.find(([pattern]) => pattern.test(body));
    return byPhrase ? { category: 'network_error', errno: byPhrase[1] } : undefined;
}
function parseSafeInteger(raw) {
    if (raw === undefined)
        return undefined;
    const value = Number.parseInt(raw, 10);
    return Number.isSafeInteger(value) ? value : undefined;
}
//# sourceMappingURL=feishu-sdk-message-summary.js.map