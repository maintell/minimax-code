import { LLM_ERROR_STATUS_CODES, normalizeLLMError, toLLMMetricErrorKind, } from '../llm-error-classifier.js';
/** The longest serialized summary; its `fields` are trimmed to fit. */
export const MAX_PROVIDER_ERROR_SUMMARY_CHARS = 2_000;
const OTHER = 'other';
const MAX_SCANNED_CHARS = 64 * 1024;
const MAX_FIELDS = 24;
const MAX_CODES = 8;
/** Nesting of error envelopes carried as JSON text (a BYOK `errorDetail`). */
const MAX_NESTED_ENVELOPES = 3;
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const HTTP_STATUS_RE = /(?:^|[\s:])([1-5]\d\d)\s/u;
/**
 * The gateway rejection format, only at the start of the text:
 * `[BYOK provider <id> upstream error: ][<status> ]upstream error (<code>):`.
 */
const GATEWAY_PREFIX_RE = /^(?:BYOK provider \S+ upstream error: )?(?:[1-5]\d\d )?upstream error \(([^()\s]{1,64})\):/u;
/** Error codes and types of the Messages and Responses protocols and of common gateways. */
const CANONICAL_CODE_NAMES = [
    'error',
    'api_error',
    'invalid_request_error',
    'authentication_error',
    'permission_error',
    'not_found_error',
    'request_too_large',
    'rate_limit_error',
    'overloaded_error',
    'timeout_error',
    'billing_error',
    'invalid_api_key',
    'insufficient_quota',
    'rate_limit_exceeded',
    'context_length_exceeded',
    'model_not_found',
    'server_error',
    'invalid_value',
    'invalid_type',
    'missing_required_parameter',
    'unsupported_parameter',
    'content_filter',
    'content_policy_violation',
    // RPC status names some gateways report, in either case.
    'invalid_argument',
    'failed_precondition',
    'out_of_range',
    'resource_exhausted',
    'unavailable',
    'deadline_exceeded',
    'internal',
    'unauthenticated',
    'permission_denied',
    'not_found',
    'already_exists',
    'aborted',
    'cancelled',
    'unimplemented',
    'data_loss',
    'unknown',
    // The BYOK error envelope.
    'byok_upstream',
];
/** Lower-cased spelling → canonical name. */
const CANONICAL_CODES = new Map([
    ...CANONICAL_CODE_NAMES.map((name) => [name, name]),
    ...Object.keys(LLM_ERROR_STATUS_CODES).map((name) => [name.toLowerCase(), name]),
]);
/** The BYOK envelope's numeric `errorCode` → its name. */
const NUMERIC_CODES = new Map(Object.entries(LLM_ERROR_STATUS_CODES).map(([name, code]) => [code, name]));
/** Node and undici transport error codes, each matched only as a whole word. */
const TRANSPORT_CODES = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPROTO',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_CLOSED',
    'UND_ERR_ABORTED',
];
const TRANSPORT_CODE_RE = new RegExp(`(?<![A-Za-z0-9_])(?:${TRANSPORT_CODES.join('|')})(?![A-Za-z0-9_])`, 'gu');
/** Transport failures reported as phrases, each mapped to one canonical name. */
const TRANSPORT_PHRASES = [
    [/\bfetch failed\b/iu, 'fetch_failed'],
    [/\bsocket hang up\b/iu, 'socket_hang_up'],
    [/\bother side closed\b/iu, 'other_side_closed'],
    [/\bnetwork error\b/iu, 'network_error'],
];
/** Field names of an error envelope, kept in `fields`; any other name becomes `?`. */
const ENVELOPE_KEYS = new Set([
    'type',
    'code',
    'status',
    'message',
    'param',
    'error',
    'error_code',
    'error_type',
    'errorCode',
    'errorSource',
    'errorDetail',
    'errorProviderId',
    'request_id',
    'requestId',
]);
/** Envelope fields whose value names the error, at the envelope root or in its `error` object. */
const CODE_KEYS = new Set([
    'type',
    'code',
    'status',
    'error_code',
    'error_type',
    'errorCode',
    'errorSource',
]);
/**
 * Every value the summary's named fields can take, for checks that it stays
 * closed. `kind` and `signals` take the shared classifier's fixed names; a
 * `fields` path is made of these names, `?` for any other field and `$` for
 * an array root.
 */
export const PROVIDER_ERROR_SUMMARY_VOCABULARY = {
    codes: new Set([...CANONICAL_CODES.values(), OTHER]),
    transport: new Set([...TRANSPORT_CODES, ...TRANSPORT_PHRASES.map(([, name]) => name)]),
    fieldNames: new Set([...ENVELOPE_KEYS, '?', '$']),
};
export function summarizeProviderError(text, metadata = {}) {
    const scanned = text.slice(0, MAX_SCANNED_CHARS);
    const status = HTTP_STATUS_RE.exec(scanned)?.[1];
    const requestId = trustedProviderRequestId(metadata.requestId);
    const facts = normalizeLLMError({ finishReason: 'error', errorMessage: scanned }).facts;
    const envelope = { fields: [], codes: new Set() };
    addGatewayCode(scanned, envelope);
    describeRoot(scanned, envelope);
    const transport = transportFailures(scanned);
    return bounded({
        chars: text.length,
        ...(status ? { status: Number(status) } : {}),
        ...(requestId ? { requestId } : {}),
        kind: toLLMMetricErrorKind(facts),
        ...(facts.signals.size > 0 ? { signals: [...facts.signals].sort() } : {}),
        ...(envelope.codes.size > 0 ? { codes: [...envelope.codes].slice(0, MAX_CODES) } : {}),
        ...(transport.length > 0 ? { transport } : {}),
        ...(envelope.fields.length > 0 ? { fields: envelope.fields } : {}),
    });
}
/** A request id taken from trusted metadata, kept only in the accepted form. */
export function trustedProviderRequestId(value) {
    return typeof value === 'string' && REQUEST_ID_RE.test(value) ? value : undefined;
}
/** Trims `fields` until the serialized summary fits. */
function bounded(summary) {
    if (JSON.stringify(summary).length <= MAX_PROVIDER_ERROR_SUMMARY_CHARS)
        return summary;
    const { fields = [], ...rest } = summary;
    for (let count = fields.length - 1; count > 0; count -= 1) {
        const trimmed = { ...rest, fields: fields.slice(0, count) };
        if (JSON.stringify(trimmed).length <= MAX_PROVIDER_ERROR_SUMMARY_CHARS)
            return trimmed;
    }
    return rest;
}
function canonicalCode(value) {
    if (typeof value === 'number')
        return NUMERIC_CODES.get(value) ?? OTHER;
    if (typeof value !== 'string')
        return undefined;
    return CANONICAL_CODES.get(value.toLowerCase()) ?? OTHER;
}
function addCode(out, value) {
    const code = canonicalCode(value);
    if (code)
        out.codes.add(code);
}
function addGatewayCode(text, out) {
    const code = GATEWAY_PREFIX_RE.exec(text)?.[1];
    if (code)
        addCode(out, code);
}
function transportFailures(text) {
    const found = new Set(text.match(TRANSPORT_CODE_RE) ?? []);
    return [
        ...TRANSPORT_CODES.filter((code) => found.has(code)),
        ...TRANSPORT_PHRASES.flatMap(([pattern, name]) => (pattern.test(text) ? [name] : [])),
    ];
}
/**
 * The JSON an error text carries after its prefix, such as `400 {"error":...}`,
 * parsed whole from its first bracket: an array root is not an envelope.
 */
function rootJson(text) {
    const start = text.search(/[[{]/u);
    if (start < 0)
        return undefined;
    const end = text.lastIndexOf(text[start] === '{' ? '}' : ']');
    if (end <= start)
        return undefined;
    try {
        return JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
}
function describeRoot(text, out) {
    const root = rootJson(text);
    if (isRecord(root))
        describeEnvelope(root, '', 0, out);
    else if (Array.isArray(root))
        pushField(out, `$:${shape(root)}`);
}
/**
 * One error envelope: its root and its `error` object. Codes come only from
 * these two levels; any other value (an echoed input, say) is recorded by its
 * shape alone, and a BYOK `errorDetail` is read as the next envelope.
 */
function describeEnvelope(envelope, path, nesting, out) {
    describeLevel(envelope, path, out, (key, value, fieldPath) => {
        if (key === 'error' && isRecord(value)) {
            describeLevel(value, fieldPath, out, () => false);
            return true;
        }
        if (key !== 'errorDetail' || typeof value !== 'string' || nesting >= MAX_NESTED_ENVELOPES)
            return false;
        addGatewayCode(value, out);
        const nested = rootJson(value);
        if (!isRecord(nested))
            return false;
        pushField(out, `${fieldPath}:json`);
        describeEnvelope(nested, fieldPath, nesting + 1, out);
        return true;
    });
}
/** Records each field of one envelope level; `descend` handles the fields it opens. */
function describeLevel(level, path, out, descend) {
    for (const [key, value] of Object.entries(level)) {
        const known = ENVELOPE_KEYS.has(key);
        const name = known ? key : '?';
        const fieldPath = path ? `${path}.${name}` : name;
        if (CODE_KEYS.has(key))
            addCode(out, value);
        if (!known || !descend(key, value, fieldPath))
            pushField(out, `${fieldPath}:${shape(value)}`);
    }
}
function pushField(out, field) {
    if (out.fields.length < MAX_FIELDS)
        out.fields.push(field);
}
function shape(value) {
    if (typeof value === 'string')
        return `string(${value.length})`;
    if (Array.isArray(value))
        return `array(${value.length})`;
    if (isRecord(value))
        return `object(${Object.keys(value).length})`;
    return value === null ? 'null' : typeof value;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=provider-error-summary.js.map