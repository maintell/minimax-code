/**
 * Shared LLM error classifier — single source of truth for both daemon
 * (`runtime=llm-client`, `runtime=Vercel` finishStep) and the legacy local runtime
 * plugin (`finish-step` / `error` events).
 *
 * Why shared instead of two parallel copies:
 *   • The metric label `error_reason` on `llm_call_total` and
 *     `tool_call_total` consumes a fixed bounded enum. If daemon and
 *     plugin classify the same error differently, we get two different
 *     time series for the same incident — Grafana dashboards break.
 *   • The plugin only sees the post-SDK normalised shape (a plain
 *     `{ statusCode, errorMessage, finishReason }` triple) while the daemon
 *     sees the raw thrown value (often `APICallError` or a `DOMException`).
 *     Both inputs collapse into the same enum here.
 *
 * Adding a new bucket: append to `LLM_ERROR_REASONS`, update the matching
 * branch in `classifyLLMError`, and bump the
 * `metrics-runtime.test.ts > schema enum sync` snapshot if needed.
 */
export const LLM_ERROR_REASONS = [
    'abort',
    'timeout',
    'rate_limited',
    'tpm_rate_limited',
    'usage_limit',
    'credits_exhausted',
    'auth',
    'bad_request',
    'not_found',
    'content_filter',
    'server_error',
    'overloaded',
    'network',
    'empty_response',
    'unknown',
    'length',
];
export const LLM_RETRY_REASONS = [
    'timeout',
    'network',
    'rate_limited',
    'tpm_rate_limited',
    'overloaded',
];
/**
 * Model-side safety classifier decline (Messages API `stop_reason: "refusal"`). Providers surface it
 * as an error message carrying this token; the remaining text is provider-controlled and must not
 * feed status/network heuristics.
 */
const PROVIDER_REFUSAL_MESSAGE_RE = /\bstop_reason:\s*refusal\b/i;
/** True when an LLM error message reports a provider safety refusal; it must not be retried. */
export function isLLMProviderRefusalMessage(message) {
    return typeof message === 'string' && PROVIDER_REFUSAL_MESSAGE_RE.test(message);
}
const EMPTY_FACTS = () => ({
    explicitAbort: false,
    timeout: false,
    signals: new Set(),
});
const SAFE_NETWORK_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ESOCKETTIMEDOUT',
    'ECONNABORTED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_CLOSED',
    'ERR_NETWORK_IO_SUSPENDED',
    'ERR_NETWORK_CHANGED',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_HTTP2_PROTOCOL_ERROR',
    // Retry this record-integrity failure, not arbitrary TLS/certificate errors.
    'ERR_SSL_BAD_RECORD_MAC_ALERT',
    'ERR_TIMED_OUT',
    'ERR_CONNECTION_TIMED_OUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
]);
const CONNECTION_ERROR_MESSAGE_RE = /Connection error\.?/i;
const ABORT_MESSAGE_RE = /\babort(?:ed|ing)?\b/i;
const TRANSIENT_TIMEOUT_MESSAGE_RE = /\b(?:timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/i;
const TRANSIENT_NETWORK_MESSAGE_RE = /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|network)\b/i;
const SAFE_TRANSPORT_NETWORK_MESSAGE_RE = /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed)\b/i;
const CHROMIUM_NETWORK_MESSAGE_RE = /\bnet::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED)|NETWORK_IO_SUSPENDED|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|HTTP2_PROTOCOL_ERROR|SSL_BAD_RECORD_MAC_ALERT)\b/i;
const CHROMIUM_TIMEOUT_MESSAGE_RE = /\bnet::ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)\b/i;
const LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODES = [2056, 2067];
const LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_SET = new Set(LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODES);
const LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_RE = /\b(?:2056|2067)\b/u;
// MiniMax "请求处理超时，请稍后重试 (2066)": the provider gave up on the request
// server-side. It is a transient timeout, but its text has no English timeout
// keyword, so recognise the provider code itself.
const LLM_TIMEOUT_UPSTREAM_STATUS_CODE = 2066;
const LLM_TIMEOUT_UPSTREAM_STATUS_CODE_RE = /\b2066\b/u;
function isLLMUsageLimitUpstreamStatusCode(statusCode) {
    return statusCode !== undefined && LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_SET.has(statusCode);
}
/** Best-effort, bounded and no-throw extraction of stable LLM error facts. */
export function normalizeLLMError(input) {
    try {
        const facts = EMPTY_FACTS();
        const signals = facts.signals;
        facts.explicitAbort = input.explicitAbort === true || input.finishReason === 'aborted';
        if (input.finishReason === 'length')
            signals.add('length');
        if (input.finishReason === 'content-filter' || input.finishReason === 'content_filter') {
            signals.add('content_filter');
        }
        const extracted = safeExtract(input.raw);
        facts.httpStatus ??= validHttpStatus(input.statusCode) ?? extracted.httpStatus;
        facts.upstreamStatusCode ??= extracted.upstreamStatusCode;
        facts.providerMessageCode ??= extracted.providerMessageCode;
        facts.existingProtocolCode ??= extracted.existingProtocolCode;
        facts.explicitAbort ||= extracted.explicitAbort === true;
        facts.timeout ||= extracted.timeout === true;
        if (extracted.network)
            signals.add('network');
        const visibleMessage = extracted.message ?? input.errorMessage;
        if (isLLMProviderRefusalMessage(visibleMessage)) {
            signals.add('refusal');
            signals.add('content_filter');
            return { facts, ...(visibleMessage ? { sanitizedMessage: visibleMessage } : {}) };
        }
        const legacy = extractLegacyMessageFacts(visibleMessage);
        facts.httpStatus ??= legacy.httpStatus;
        facts.upstreamStatusCode ??= legacy.upstreamStatusCode;
        facts.existingProtocolCode ??= legacy.existingProtocolCode;
        const message = legacy.message ?? visibleMessage;
        applyMessageSignals(message, facts, signals);
        applyNumericSignals(facts, signals);
        return { facts, ...(message ? { sanitizedMessage: message } : {}) };
    }
    catch {
        return {
            facts: EMPTY_FACTS(),
            ...(typeof input.errorMessage === 'string' ? { sanitizedMessage: input.errorMessage } : {}),
        };
    }
}
export function toLLMMetricErrorKind(facts) {
    try {
        if (facts.explicitAbort)
            return 'abort';
        if (facts.signals.has('refusal'))
            return 'content_filter';
        if (facts.signals.has('credits_exhausted'))
            return 'credits_exhausted';
        if (facts.signals.has('usage_limit'))
            return 'usage_limit';
        if (facts.signals.has('tpm_rate_limit'))
            return 'tpm_rate_limited';
        if (facts.timeout && effectiveHttpStatus(facts) === 529)
            return 'overloaded';
        if (facts.timeout)
            return 'timeout';
        if (facts.signals.has('content_filter'))
            return 'content_filter';
        if (facts.signals.has('empty_response'))
            return 'empty_response';
        if (facts.signals.has('length'))
            return 'length';
        switch (facts.existingProtocolCode) {
            case LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED:
                return 'usage_limit';
            case LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED:
                return 'credits_exhausted';
            case LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED:
                return 'tpm_rate_limited';
            case LLM_ERROR_CODES.LLM_RATE_LIMITED:
                return 'rate_limited';
            case LLM_ERROR_CODES.LLM_AUTH_ERROR:
                return 'auth';
            case LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED:
                return 'overloaded';
        }
        const status = effectiveHttpStatus(facts);
        if (status === 429)
            return 'rate_limited';
        if (status === 401 || status === 403)
            return 'auth';
        if (status === 404)
            return 'not_found';
        if (status !== undefined && status >= 400 && status < 500)
            return 'bad_request';
        if (status === 529)
            return 'overloaded';
        if (facts.signals.has('network'))
            return 'network';
        if (status !== undefined && status >= 500)
            return 'server_error';
        return 'unknown';
    }
    catch {
        return 'unknown';
    }
}
/**
 * Strict transport-retry policy shared by all hosts that opt into framework retry.
 *
 * Product quota, credits, auth and explicit cancellation always win over an outer
 * transient-looking HTTP status. Only the bounded allowlist below is retryable;
 * generic 5xx and unknown failures deliberately fail closed.
 */
export function toLLMRetryDecision(normalized) {
    const { facts } = normalized;
    const metricKind = toLLMMetricErrorKind(facts);
    if (facts.explicitAbort ||
        facts.signals.has('usage_limit') ||
        facts.signals.has('credits_exhausted') ||
        facts.signals.has('content_filter') ||
        facts.signals.has('refusal') ||
        metricKind === 'abort' ||
        metricKind === 'usage_limit' ||
        metricKind === 'credits_exhausted' ||
        metricKind === 'auth') {
        return { retryable: false, reason: metricKind };
    }
    const status = effectiveHttpStatus(facts);
    if (facts.existingProtocolCode === LLM_ERROR_CODES.LLM_AUTH_ERROR ||
        status === 401 ||
        status === 403) {
        return { retryable: false, reason: 'auth' };
    }
    if (facts.timeout)
        return { retryable: true, reason: 'timeout' };
    if (facts.signals.has('network'))
        return { retryable: true, reason: 'network' };
    switch (facts.existingProtocolCode) {
        case LLM_ERROR_CODES.LLM_RATE_LIMITED:
            return { retryable: true, reason: 'rate_limited' };
        case LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED:
            return { retryable: true, reason: 'tpm_rate_limited' };
        case LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED:
            return { retryable: true, reason: 'overloaded' };
    }
    if (status === 429) {
        return {
            retryable: true,
            reason: facts.signals.has('tpm_rate_limit') ? 'tpm_rate_limited' : 'rate_limited',
        };
    }
    if (status === 529)
        return { retryable: true, reason: 'overloaded' };
    return { retryable: false, reason: metricKind };
}
export function toLLMProtocolClassification(normalized) {
    try {
        const { facts, sanitizedMessage } = normalized;
        const httpStatus = effectiveHttpStatus(facts);
        let code;
        if (facts.existingProtocolCode &&
            Object.values(LLM_ERROR_CODES).includes(facts.existingProtocolCode)) {
            code = facts.existingProtocolCode;
        }
        else if (facts.signals.has('credits_exhausted')) {
            code = LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED;
        }
        else if (isLLMUsageLimitUpstreamStatusCode(facts.upstreamStatusCode)) {
            code = LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED;
        }
        else if (httpStatus === 429 && facts.signals.has('tpm_rate_limit')) {
            code = LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED;
        }
        else if (httpStatus === 529) {
            code = LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED;
        }
        else if (httpStatus !== undefined) {
            code = mapUpstreamHttpError(httpStatus);
        }
        else if (facts.timeout) {
            code = LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
        }
        return code === undefined
            ? null
            : { code, ...(sanitizedMessage ? { message: sanitizedMessage } : {}) };
    }
    catch {
        return null;
    }
}
function safeExtract(raw) {
    const out = {};
    const seen = new WeakSet();
    const queue = [{ value: raw, depth: 0 }];
    let visited = 0;
    while (queue.length > 0 && visited++ < 32) {
        const item = queue.shift();
        if (item.depth > 4 || typeof item.value !== 'object' || item.value === null)
            continue;
        if (seen.has(item.value))
            continue;
        seen.add(item.value);
        if (item.value instanceof Error ||
            (typeof DOMException !== 'undefined' && item.value instanceof DOMException)) {
            const builtinError = item.value;
            if (builtinError.name === 'AbortError')
                out.explicitAbort = true;
            if (/TimeoutError/u.test(builtinError.name))
                out.timeout = true;
            if (!out.message && builtinError.message)
                out.message = sanitizeMessage(builtinError.message);
        }
        let descriptors;
        try {
            descriptors = Object.getOwnPropertyDescriptors(item.value);
        }
        catch {
            continue;
        }
        const value = (key) => {
            const descriptor = descriptors[key];
            return descriptor && 'value' in descriptor ? descriptor.value : undefined;
        };
        const name = value('name');
        const code = value('code');
        if (name === 'AbortError')
            out.explicitAbort = true;
        if (typeof name === 'string' && /TimeoutError/u.test(name))
            out.timeout = true;
        if (typeof code === 'string' && SAFE_NETWORK_CODES.has(code)) {
            out.network = true;
            if (isLLMTransportTimeoutCode(code))
                out.timeout = true;
        }
        const statusCode = validHttpStatus(value('statusCode')) ?? validHttpStatus(value('status'));
        out.httpStatus ??= statusCode;
        if (name === 'APICallError' && statusCode === undefined && item.value instanceof Error) {
            out.network = true;
        }
        const upstream = validInteger(value('status_code'));
        out.upstreamStatusCode ??= upstream;
        const existing = validInteger(value('errorCode'));
        out.existingProtocolCode ??= existing;
        const providerCode = validInteger(value('code'));
        if (providerCode !== undefined && providerCode < 10000)
            out.providerMessageCode ??= providerCode;
        const statusMessage = value('status_message') ?? value('status_msg');
        const message = value('message');
        if (typeof statusMessage === 'string')
            out.message = sanitizeMessage(statusMessage);
        else if (!out.message && typeof message === 'string')
            out.message = sanitizeMessage(message);
        const responseBody = value('responseBody');
        if (typeof responseBody === 'string' && responseBody.length <= 64_000) {
            try {
                queue.push({ value: JSON.parse(responseBody), depth: item.depth + 1 });
            }
            catch {
                /* compatibility fallback */
            }
        }
        for (const key of ['cause', 'error', 'data']) {
            queue.push({ value: value(key), depth: item.depth + 1 });
        }
    }
    return out;
}
function validInteger(value) {
    return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 2_000_000_000
        ? value
        : undefined;
}
function validHttpStatus(value) {
    const n = validInteger(value);
    return n !== undefined && n >= 100 && n <= 599 ? n : undefined;
}
function sanitizeMessage(message) {
    return message.slice(0, 4096);
}
function extractLegacyMessageFacts(message) {
    if (!message)
        return {};
    const boundedMessage = sanitizeMessage(message);
    const extracted = tryExtractFromPayload({ message: boundedMessage });
    const classified = classifyLLMErrorToCode(boundedMessage);
    const statusCode = validInteger(extracted.statusCode);
    const httpStatus = validHttpStatus(statusCode);
    return {
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(statusCode !== undefined && httpStatus === undefined
            ? { upstreamStatusCode: statusCode }
            : {}),
        ...(classified ? { existingProtocolCode: classified.status_code } : {}),
        ...(extracted.message ? { message: sanitizeMessage(extracted.message) } : {}),
    };
}
function applyNumericSignals(facts, signals) {
    const httpStatus = effectiveHttpStatus(facts);
    if (facts.upstreamStatusCode === 1400010161 ||
        facts.providerMessageCode === 1008 ||
        httpStatus === 402)
        signals.add('credits_exhausted');
    if (isLLMUsageLimitUpstreamStatusCode(facts.upstreamStatusCode))
        signals.add('usage_limit');
    if (facts.upstreamStatusCode === LLM_TIMEOUT_UPSTREAM_STATUS_CODE ||
        facts.providerMessageCode === LLM_TIMEOUT_UPSTREAM_STATUS_CODE)
        facts.timeout = true;
    if (httpStatus === 429 &&
        [2045, 2046, 2047, 1039, 1041].includes(facts.providerMessageCode ?? -1))
        signals.add('tpm_rate_limit');
}
function effectiveHttpStatus(facts) {
    return validHttpStatus(facts.upstreamStatusCode) ?? facts.httpStatus;
}
function applyMessageSignals(message, facts, signals) {
    if (!message)
        return;
    if (/\brequest was aborted\b/i.test(message))
        facts.explicitAbort = true;
    if (/\b429\b/u.test(message) || /rate[_\s-]?limit(?:ed)?/i.test(message))
        facts.httpStatus ??= 429;
    if (/\b529\b/u.test(message) || /cluster\s+overload/i.test(message))
        facts.httpStatus ??= 529;
    if (/\b(?:2045|2046|2047|1039|1041)\b/u.test(message))
        signals.add('tpm_rate_limit');
    if (LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_RE.test(message) ||
        /usage[_\s-](?:limit[_\s-])?(?:reached|exceeded|not[_\s-]included)/i.test(message))
        signals.add('usage_limit');
    if (/\b(?:1400010161|1008)\b/u.test(message) ||
        /credits?\s+exhausted|insufficient\s+balance/i.test(message))
        signals.add('credits_exhausted');
    if (ABORT_MESSAGE_RE.test(message) ||
        TRANSIENT_TIMEOUT_MESSAGE_RE.test(message) ||
        CHROMIUM_TIMEOUT_MESSAGE_RE.test(message) ||
        LLM_TIMEOUT_UPSTREAM_STATUS_CODE_RE.test(message))
        facts.timeout = true;
    if (CONNECTION_ERROR_MESSAGE_RE.test(message) ||
        TRANSIENT_NETWORK_MESSAGE_RE.test(message) ||
        CHROMIUM_NETWORK_MESSAGE_RE.test(message))
        signals.add('network');
    if (/\bempty.?response/i.test(message))
        signals.add('empty_response');
    const hasStructuredError = facts.existingProtocolCode !== undefined || effectiveHttpStatus(facts) !== undefined;
    if (!hasStructuredError && /\b(content.?filter|content.?policy|safety|blocked)\b/i.test(message))
        signals.add('content_filter');
}
export function classifyFinishStepError(input) {
    const { finishReason, statusCode, errorMessage } = input;
    if (finishReason === 'length')
        return 'length';
    if (isLLMProviderRefusalMessage(errorMessage))
        return 'content_filter';
    if (finishReason === 'content-filter' || finishReason === 'content_filter') {
        return 'content_filter';
    }
    if (typeof statusCode === 'number') {
        if (statusCode === 429)
            return 'rate_limited';
        if (statusCode === 401 || statusCode === 403)
            return 'auth';
        if (statusCode === 404)
            return 'not_found';
        if (statusCode >= 400 && statusCode < 500)
            return 'bad_request';
    }
    if (errorMessage) {
        if (ABORT_MESSAGE_RE.test(errorMessage) ||
            TRANSIENT_TIMEOUT_MESSAGE_RE.test(errorMessage) ||
            CHROMIUM_TIMEOUT_MESSAGE_RE.test(errorMessage) ||
            LLM_TIMEOUT_UPSTREAM_STATUS_CODE_RE.test(errorMessage)) {
            return 'timeout';
        }
        if (CONNECTION_ERROR_MESSAGE_RE.test(errorMessage) ||
            TRANSIENT_NETWORK_MESSAGE_RE.test(errorMessage) ||
            CHROMIUM_NETWORK_MESSAGE_RE.test(errorMessage)) {
            return 'network';
        }
        if (/\bempty.?response/i.test(errorMessage))
            return 'empty_response';
        if (/\b(content.?filter|content.?policy|safety|blocked)/i.test(errorMessage)) {
            return 'content_filter';
        }
    }
    if (typeof statusCode === 'number' && statusCode >= 500)
        return 'server_error';
    if (finishReason === 'error')
        return 'unknown';
    return undefined;
}
/**
 * Daemon-side classifier — accepts a raw thrown value (`APICallError`
 * instance, `DOMException`, plain `Error`, anything). Falls through to
 * `classifyFinishStepError` for the message-pattern branches and the
 * statusCode branches when the value carries those fields.
 *
 * Plugin code should prefer `classifyFinishStepError` directly because the
 * SDK has already normalised the shape. Daemon code uses this entry point.
 */
export function classifyLLMError(err) {
    if (err instanceof Error && isLLMProviderRefusalMessage(err.message))
        return 'content_filter';
    // DOMException AbortError or Error message-text "timeout/abort" — same
    // bucket whether it came from `AbortController.abort()` or a server-side
    // 504 with no explicit status.
    const isAbort = (typeof DOMException !== 'undefined' &&
        err instanceof DOMException &&
        err.name === 'AbortError') ||
        (err instanceof Error &&
            (ABORT_MESSAGE_RE.test(err.message) ||
                TRANSIENT_TIMEOUT_MESSAGE_RE.test(err.message) ||
                CHROMIUM_TIMEOUT_MESSAGE_RE.test(err.message)));
    if (isAbort)
        return 'timeout';
    // Vercel AI SDK's APICallError carries statusCode but isn't a subclass of
    // Error in older versions. Detect via duck-typing on `name === 'APICallError'`
    // (or via the SDK's `isInstance` when available — see daemon shim).
    const errorCode = extractErrorCode(err);
    const errorMessage = extractErrorMessage(err);
    const apiStatus = extractAPICallErrorStatus(err);
    if (apiStatus !== undefined) {
        if (apiStatus === 429)
            return 'rate_limited';
        if (apiStatus === 401 || apiStatus === 403)
            return 'auth';
        if (apiStatus === 404)
            return 'not_found';
        if (apiStatus >= 400 && apiStatus < 500)
            return 'bad_request';
        if (errorCode !== undefined && SAFE_NETWORK_CODES.has(errorCode)) {
            return isLLMTransportTimeoutCode(errorCode) ? 'timeout' : 'network';
        }
        if (errorMessage !== undefined) {
            if (isLLMTransportTimeoutSignal(errorMessage))
                return 'timeout';
            if (isLLMTransportNetworkSignal(errorMessage))
                return 'network';
        }
        if (apiStatus >= 500)
            return 'server_error';
        // statusCode === undefined on APICallError is the SDK's "no response
        // came back at all" sentinel — treat as a network error.
    }
    if (errorCode !== undefined && SAFE_NETWORK_CODES.has(errorCode)) {
        return isLLMTransportTimeoutCode(errorCode) ? 'timeout' : 'network';
    }
    const isAPICallErrorWithoutStatus = apiStatus === undefined && err instanceof Error && err.name === 'APICallError';
    if (isAPICallErrorWithoutStatus)
        return 'network';
    if (err instanceof TypeError ||
        (err instanceof Error &&
            (CONNECTION_ERROR_MESSAGE_RE.test(err.message) ||
                TRANSIENT_NETWORK_MESSAGE_RE.test(err.message) ||
                CHROMIUM_NETWORK_MESSAGE_RE.test(err.message)))) {
        return 'network';
    }
    if (err instanceof Error &&
        /\b(content.?filter|content.?policy|safety|blocked)/i.test(err.message)) {
        return 'content_filter';
    }
    if (err instanceof Error && /\bempty.?response/i.test(err.message)) {
        return 'empty_response';
    }
    return 'unknown';
}
/**
 * Best-effort extraction of `statusCode` from an unknown thrown value. We
 * read the field directly so this module stays free of the `ai` package
 * dependency (which `@mavis/shared` cannot import — it would pull the
 * Vercel AI SDK into the plugin bundle).
 */
function extractAPICallErrorStatus(err) {
    if (typeof err !== 'object' || err === null)
        return undefined;
    const candidate = err;
    if (candidate.name !== 'APICallError')
        return undefined;
    if (typeof candidate.statusCode === 'number')
        return candidate.statusCode;
    return undefined;
}
function extractErrorCode(err) {
    if (typeof err !== 'object' || err === null)
        return undefined;
    const candidate = err;
    return typeof candidate.code === 'string' ? candidate.code : undefined;
}
function extractErrorMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err !== 'object' || err === null)
        return undefined;
    const candidate = err;
    return typeof candidate.message === 'string' ? candidate.message : undefined;
}
// ────────────────────────────────────────────────────────────────────────────
// LLM error → shared session-status status_code (cloud-runtime wire normalize)
// ────────────────────────────────────────────────────────────────────────────
//
// 跟上面 `classifyLLMError` 的 bounded metric label 互补:这里产出的是
// runtime numeric status_code,塞进 wire (BusEvent.errorCode /
// ProtocolError.code),让前端 typed error-code 文案和状态分支命中。
// 其中 42212 / 50110 / 50150 会进入 UI `ChatStatus.RunOutOfCredit`;
// 50111 是短期请求限流，进入 output retry；50151 展示集群高负载错误文案。
//
// 这些 code 是跨 runtime 共享 wire 常量。不能从某个宿主包反向 import,
// 否则 cloud-runtime/local-runtime 会重新耦合到本地宿主实现。
export const LLM_ERROR_STATUS_CODES = {
    /** USAGE_LIMIT_EXCEEDED — quota 满 / 用量到顶 */
    USAGE_LIMIT_EXCEEDED: 42212,
    /** LLM_CREDITS_EXHAUSTED — provider 报余额耗尽 / HTTP 402 */
    LLM_CREDITS_EXHAUSTED: 50110,
    /** daemon LLM_RATE_LIMITED — HTTP 429 */
    LLM_RATE_LIMITED: 50111,
    /** daemon LLM_AUTH_ERROR — HTTP 401/403 */
    LLM_AUTH_ERROR: 50112,
    /** daemon LLM_UPSTREAM_ERROR — generic 4xx/5xx fallback */
    LLM_UPSTREAM_ERROR: 50113,
    /** daemon LLM_MIGRATION_ERROR — OP migration path failed */
    LLM_MIGRATION_ERROR: 50114,
    /** daemon LLM_TPM_RATE_LIMITED — provider TPM/RPM short-term throttling */
    LLM_TPM_RATE_LIMITED: 50150,
    /** LLM_CLUSTER_OVERLOADED — HTTP 529 */
    LLM_CLUSTER_OVERLOADED: 50151,
};
// Backward-compatible name for UI typed-match imports.
export const LLM_ERROR_CODES = LLM_ERROR_STATUS_CODES;
export const LLM_TPM_RATE_LIMIT_MESSAGE_CODES = [2045, 2046, 2047, 1039, 1041];
const LLM_TPM_RATE_LIMIT_MESSAGE_CODE_RE = /\b(?:2045|2046|2047|1039|1041)\b/u;
export function isLLMTpmRateLimitMessage(message) {
    return message !== undefined && LLM_TPM_RATE_LIMIT_MESSAGE_CODE_RE.test(message);
}
/**
 * 上游 MiniMax / OpenAI 风格 provider 的 status_code → daemon ErrorCode 映射。
 * 数值跟 daemon `local-proxy-handler.ts::UPSTREAM_CODE_MAP` 同源。
 */
export const UPSTREAM_STATUS_CODE_MAP = {
    // MiniMax internal status: 余额不足 → 50110
    1400010161: LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED,
    // MiniMax internal status: 用量超限 → 42212
    2056: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
    // Token Plan 已达限且积分自动消耗关闭 → 42212
    2067: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
};
/**
 * 从未知 raw value 抠 `{ status_code, errorCode, code, message }` 信号 — 兼容
 * 多种 envelope 嵌套(`{error: {responseBody: '{"status_code":...}'}}` 这种
 * Vercel AI SDK / DOMException 包装)。
 *
 * 递归 unwrap 三层:`err.responseBody` (JSON string) → `err.error` (nested obj)
 * → `err.data` → `err.status`。
 */
export function tryExtractFromPayload(raw) {
    if (typeof raw !== 'object' || raw === null)
        return {};
    const obj = raw;
    const out = {};
    // ── pass 1: nested envelopes first ──────────────────────────────────────
    // Business-level codes (inner upstream `status_code`) MUST take priority
    // over transport-level codes (outer HTTP `statusCode`). AI SDK
    // APICallError wraps upstream payload as `{statusCode: 500,
    // responseBody: '{"status_code": 1400010161, ...}'}` — the inner 1400010161
    // is the real cause (MiniMax credit exhausted → 50110), the outer 500 is
    // just HTTP transport. We collect nested signals FIRST, then let outer
    // fields fill in only what nested didn't provide.
    let nested = {};
    if (typeof obj.responseBody === 'string') {
        try {
            const inner = JSON.parse(obj.responseBody);
            const innerExtract = tryExtractFromPayload(inner);
            nested = { ...innerExtract };
        }
        catch {
            // ignore parse fail
        }
    }
    if (typeof obj.error === 'object' && obj.error !== null) {
        const innerExtract = tryExtractFromPayload(obj.error);
        nested.statusCode ??= innerExtract.statusCode;
        nested.errorCode ??= innerExtract.errorCode;
        nested.message ??= innerExtract.message;
    }
    if (typeof obj.data === 'object' && obj.data !== null) {
        const innerExtract = tryExtractFromPayload(obj.data);
        nested.statusCode ??= innerExtract.statusCode;
        nested.errorCode ??= innerExtract.errorCode;
        nested.message ??= innerExtract.message;
    }
    // `obj.cause` (Error chain root cause via `new Error('...', { cause: orig })`)
    // — some SDK wrappers (Vercel AI / Vercel) re-throw the original
    // provider Error as `.cause` while putting their own format string in
    // `.message`. Recurse so the original typed signal isn't lost.
    if (typeof obj.cause === 'object' && obj.cause !== null) {
        const innerExtract = tryExtractFromPayload(obj.cause);
        nested.statusCode ??= innerExtract.statusCode;
        nested.errorCode ??= innerExtract.errorCode;
        nested.message ??= innerExtract.message;
    }
    out.statusCode = nested.statusCode;
    out.errorCode = nested.errorCode;
    out.message = nested.message;
    // ── pass 2: outer fields fill blanks ────────────────────────────────────
    if (out.statusCode === undefined && typeof obj.status_code === 'number') {
        out.statusCode = obj.status_code;
    }
    if (out.statusCode === undefined && typeof obj.statusCode === 'number') {
        out.statusCode = obj.statusCode;
    }
    // Messages-compatible SDK `APIError` uses `.status` (number); other SDKs
    // use `.statusCode`. Pick whichever appears.
    if (out.statusCode === undefined && typeof obj.status === 'number') {
        out.statusCode = obj.status;
    }
    if (out.errorCode === undefined && typeof obj.errorCode === 'number') {
        out.errorCode = obj.errorCode;
    }
    if (out.errorCode === undefined && typeof obj.code === 'number') {
        out.errorCode = obj.code;
    }
    if (!out.message && typeof obj.message === 'string')
        out.message = obj.message;
    if (!out.message && typeof obj.status_message === 'string')
        out.message = obj.status_message;
    if (!out.message && typeof obj.status_msg === 'string')
        out.message = obj.status_msg;
    if (!out.message && typeof obj.error === 'string')
        out.message = obj.error;
    // ── pass 3: message string fallback ──────────────────────────────────────
    // Some SDKs throw APIError whose toString() is
    // `[Error] <status> <json-body>`, Vercel / Vercel AI re-wrappers, etc.)
    // collapse the typed fields into a plain text `message` string before
    // throwing. Try to recover the signal from that string when typed fields
    // didn't already cover it.
    if (typeof obj.message === 'string') {
        const fromMsg = extractFromMessageString(obj.message);
        out.statusCode ??= fromMsg.statusCode;
        out.errorCode ??= fromMsg.errorCode;
        // Inner JSON payload may also carry a richer message (e.g. provider
        // `error.message: "invalid api key"`); prefer it over the noisy raw
        // outer string when available.
        if (fromMsg.message)
            out.message = fromMsg.message;
    }
    return out;
}
// extractFromMessageString — best-effort parse of a raw error-message
// string for an HTTP status prefix and an embedded JSON body.
//
// Handles shapes seen in real cloud-runtime logs:
//
//   `[Error] 401 {"type":"error","error":{"type":"authentication_error",
//                                          "message":"invalid api key"},
//                 "request_id":"..."}`   (Messages-compatible providers)
//   `Provider API error (429): rate limited`
//   `OpenAI 401: invalid api key`
//   `500 Internal Server Error - {"status_code":1400010161,...}`
//
// Returns `{ statusCode?, message? }`:
//   - statusCode: first 3-digit HTTP-shaped number in [400, 599] found in
//     the prefix segment (before the first `{`). Stops at 599 so random
//     numeric content in JSON body doesn't trigger false positives.
//   - message: the most specific human-readable message found in the
//     embedded JSON (`error.message` → `message` → `error` as string).
function extractFromMessageString(s) {
    const out = {};
    if (!s)
        return out;
    // 1. Find the embedded JSON body (first `{` ... last `}`).
    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    const prefix = firstBrace > 0 ? s.slice(0, firstBrace) : s;
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        const jsonSlice = s.slice(firstBrace, lastBrace + 1);
        try {
            const parsed = JSON.parse(jsonSlice);
            const innerExtract = tryExtractFromPayload(parsed);
            if (innerExtract.statusCode !== undefined)
                out.statusCode = innerExtract.statusCode;
            if (innerExtract.errorCode !== undefined)
                out.errorCode = innerExtract.errorCode;
            if (innerExtract.message)
                out.message = innerExtract.message;
        }
        catch {
            // ignore — not JSON
        }
    }
    // 2. If no statusCode from JSON body, grab first 4xx/5xx number in prefix.
    if (out.statusCode === undefined) {
        const m = prefix.match(/\b([45]\d{2})\b/);
        if (m) {
            const n = Number(m[1]);
            if (Number.isFinite(n) && n >= 400 && n <= 599) {
                out.statusCode = n;
            }
        }
    }
    return out;
}
/**
 * HTTP status → daemon ErrorCode fallback(当无 typed errorCode / upstream
 * status_code 命中时)。
 */
export function mapUpstreamHttpError(httpStatus) {
    if (httpStatus === 402)
        return LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED;
    if (httpStatus === 429)
        return LLM_ERROR_CODES.LLM_RATE_LIMITED;
    if (httpStatus === 529)
        return LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED;
    if (httpStatus === 401 || httpStatus === 403)
        return LLM_ERROR_CODES.LLM_AUTH_ERROR;
    if (httpStatus >= 400)
        return LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
    return undefined;
}
/**
 * 把 LLM 调用抛出的 raw err 归一化成 session-status status_code + sanitized message。
 *
 * 优先级:
 *   1. payload 里显式带的 `errorCode` / `code` (status_code enum) 直接用
 *   2. payload 里的上游 `status_code` 命中 UPSTREAM_STATUS_CODE_MAP(MiniMax 1400010161 / 2056 / 2067)
 *   3. message-only quota/credits signal, e.g. "usage limit exceeded (2056)"
 *   4. HTTP 429 + TPM provider message code → LLM_TPM_RATE_LIMITED(50150)
 *   5. LLM HTTP timeout signal → LLM_UPSTREAM_ERROR(50113)
 *   6. LLM transport network signal → LLM_UPSTREAM_ERROR(50113)
 *   7. payload / `err.statusCode` 是 HTTP status → mapUpstreamHttpError
 *
 * 返 `null` 表示不识别(caller 走 fallback ProtocolErrorCode.INTERNAL_ERROR)。
 *
 * `message` 字段优先用 payload 里 sanitized message(string_message / message /
 * error 文本字段);err.message 兜底。
 */
export function classifyLLMErrorToCode(err) {
    // Accept plain strings (some callers — notably pi-turn-runner capturing
    // `agent.state.errorMessage`) have already collapsed the typed error
    // shape into a single line. Wrap into `{message: str}` so the existing
    // `pass 3` string-fallback inside `tryExtractFromPayload` (status prefix
    // + embedded JSON parse) still fires.
    const normalized = typeof err === 'string' ? { message: err } : err;
    // A provider refusal is a policy outcome, not a transport/quota error. Its explanation text is
    // provider-controlled, so never derive status codes from it.
    if (isLLMProviderRefusalMessage(typeof err === 'string' ? err : extractErrorMessage(err))) {
        return null;
    }
    const extracted = tryExtractFromPayload(normalized);
    // 1. typed errorCode
    if (extracted.errorCode !== undefined) {
        const allowed = new Set(Object.values(LLM_ERROR_CODES));
        if (allowed.has(extracted.errorCode)) {
            return {
                status_code: extracted.errorCode,
                message: extracted.message ?? fallbackMessage(err),
            };
        }
    }
    // 2. upstream status_code 命中
    if (extracted.statusCode !== undefined && UPSTREAM_STATUS_CODE_MAP[extracted.statusCode]) {
        return {
            status_code: UPSTREAM_STATUS_CODE_MAP[extracted.statusCode],
            message: extracted.message ?? fallbackMessage(err),
        };
    }
    // 3. Message-only quota fallback. Some SDK/proxy wrappers collapse the
    // upstream body into plain text while keeping only a generic HTTP 500 outside.
    // Treat the business signal in the text as stronger than the transport status.
    const messageOnly = classifyQuotaSignalFromMessage(extracted.message ?? fallbackMessage(err));
    if (messageOnly)
        return messageOnly;
    const codeMessage = extracted.message ?? fallbackMessage(err);
    const transportCode = extractErrorCode(err);
    const httpStatus = extracted.statusCode ??
        (typeof err?.statusCode === 'number'
            ? err.statusCode
            : undefined);
    // 4. Provider TPM/rate-window fallback. These 429s are short-term request
    // throttles, not quota exhaustion, so they get their own product code.
    if (httpStatus === 429 && isLLMTpmRateLimitMessage(codeMessage)) {
        return {
            status_code: LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
            message: codeMessage,
        };
    }
    // 5. Structured business HTTP statuses remain stronger than transport text.
    // A misleading wrapper message such as "timed out" must not turn auth,
    // quota, rate-limit, not-found, or the explicit 529 overload response into
    // a generic transient capacity error. 5xx statuses are intentionally left
    // for the transport checks below because a 5xx wrapper may represent a
    // connection failure with no usable upstream response.
    if (httpStatus !== undefined && (httpStatus < 500 || httpStatus === 529)) {
        const mapped = mapUpstreamHttpError(httpStatus);
        if (mapped !== undefined) {
            return { status_code: mapped, message: extracted.message ?? fallbackMessage(err) };
        }
    }
    // 6. LLM HTTP timeout fallback. A transport deadline does not prove that
    // the provider returned an explicit cluster-overload response.
    const timeoutMessage = codeMessage;
    if (isLLMHttpTimeoutSignal(err, timeoutMessage)) {
        return {
            status_code: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
            message: timeoutMessage,
        };
    }
    // 7. Remaining HTTP status fallback (normally generic 5xx).
    if (httpStatus !== undefined) {
        const mapped = mapUpstreamHttpError(httpStatus);
        if (mapped !== undefined) {
            return { status_code: mapped, message: extracted.message ?? fallbackMessage(err) };
        }
    }
    // 8. LLM transport network fallback. No dedicated daemon wire code exists for
    // network, so use the generic upstream code while preserving the raw detail.
    const networkMessage = codeMessage;
    if (isLLMTransportNetworkSignal(networkMessage) || isLLMTransportNetworkCode(transportCode)) {
        return {
            status_code: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
            message: networkMessage,
        };
    }
    return null;
}
function isLLMHttpTimeoutSignal(err, message) {
    if (/\b(timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/i.test(message)) {
        return true;
    }
    if (typeof err !== 'object' || err === null)
        return false;
    const candidate = err;
    return ((typeof candidate.name === 'string' &&
        /\b(?:TimeoutError|ConnectTimeoutError|HeadersTimeoutError|BodyTimeoutError)\b/i.test(candidate.name)) ||
        (typeof candidate.code === 'string' && isLLMTransportTimeoutCode(candidate.code)));
}
function isLLMTransportTimeoutCode(code) {
    return /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|ERR_(?:CONNECTION_)?TIMED_OUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/u.test(code);
}
function isLLMTransportTimeoutSignal(message) {
    return TRANSIENT_TIMEOUT_MESSAGE_RE.test(message) || CHROMIUM_TIMEOUT_MESSAGE_RE.test(message);
}
function isLLMTransportNetworkSignal(message) {
    return (CONNECTION_ERROR_MESSAGE_RE.test(message) ||
        CHROMIUM_NETWORK_MESSAGE_RE.test(message) ||
        SAFE_TRANSPORT_NETWORK_MESSAGE_RE.test(message));
}
function isLLMTransportNetworkCode(code) {
    return code !== undefined && SAFE_NETWORK_CODES.has(code) && !isLLMTransportTimeoutCode(code);
}
function classifyQuotaSignalFromMessage(message) {
    if (/\b(?:1400010161|1008)\b/u.test(message) ||
        /credits?\s+exhausted/i.test(message) ||
        /insufficient\s+balance/i.test(message)) {
        return { status_code: LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED, message };
    }
    if (LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_RE.test(message) ||
        /usage\s+limit\s+exceeded/i.test(message) ||
        /package\s+quota\s+has\s+reached(?:\s+its)?\s+limit/i.test(message)) {
        return { status_code: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED, message };
    }
    if (/\bhibernation\b/i.test(message)) {
        return { status_code: LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED, message };
    }
    if (/requests?\s+(?:are\s+)?too\s+frequent/i.test(message)) {
        return { status_code: LLM_ERROR_CODES.LLM_RATE_LIMITED, message };
    }
    return null;
}
function fallbackMessage(err) {
    if (err instanceof Error)
        return err.message;
    if (typeof err === 'string')
        return err;
    return 'LLM call failed';
}
//# sourceMappingURL=llm-error-classifier.js.map