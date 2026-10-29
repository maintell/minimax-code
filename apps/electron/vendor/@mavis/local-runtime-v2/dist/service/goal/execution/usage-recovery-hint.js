/**
 * Capture the provider's own answer to "when does this account quota come
 * back?" and hold it until the Goal that hit it settles.
 *
 * The public LLM failure that reaches Goal settlement is deliberately
 * sanitized: by the time it is a `RuntimeProtocolError` it is a fixed status
 * code plus a fixed public sentence, with every provider detail stripped. That
 * sanitization is correct — those details must not reach the transcript — but
 * it also throws away the one fact automatic recovery needs.
 *
 * `PiLLMRequestFailureHook` is the host side-channel agent-core already
 * provides for exactly this situation: it hands the host the *raw* provider
 * error, once per physical request, with no effect on the request, the retry
 * loop or the Turn. This module reads a recovery time off that raw error and
 * parks it under the Turn id, so Goal settlement can pick it up without any of
 * it passing through the transcript.
 *
 * Two properties keep this honest:
 *
 *   - Only an explicit `usage_limit` failure is inspected. A timeout, a plain
 *     rate limit, an unknown BYOK error or a server fault never produces a
 *     hint, so they can never be mistaken for a recoverable account quota.
 *   - Only an explicit provider-supplied instant is accepted. Nothing is
 *     inferred from the failure's arrival time, and an unparseable or absurd
 *     value is dropped rather than rounded into a guess.
 */
import { normalizeUsageRecoveryAtMs, THREAD_GOAL_USAGE_RECOVERY_MAX_HORIZON_MS } from '@mavis/goal';
/**
 * Upper bound on parked hints.
 *
 * A hint is consumed when its Turn settles, but a Turn that never reaches Goal
 * settlement (an abandoned subagent call, a crash between the two points) would
 * otherwise leak one entry forever. The map is an optimisation, never a source
 * of truth, so evicting the oldest entry is always safe: the worst outcome is
 * that one Goal falls back to manual resume.
 */
const MAX_PARKED_HINTS = 256;
/**
 * Header-name suffixes that carry an absolute reset instant.
 *
 * Matched by suffix rather than by a list of vendor-specific names: providers
 * prefix their rate-limit headers with their own vendor token, and the useful
 * part is always the trailing `…-reset`. Suffix matching also means a provider
 * this project has never seen works without a code change.
 */
const RESET_HEADER_SUFFIXES = ['-unified-reset', '-ratelimit-reset', 'ratelimit-reset'];
/** Body / error-object fields that carry an absolute reset instant. */
const RESET_FIELD_NAMES = [
    'resets_at',
    'resetsAt',
    'reset_at',
    'resetAt',
    'reset_time',
    'resetTime',
    'unified_reset',
    'end_time',
];
/**
 * Per-Turn parking lot between the raw provider failure and Goal settlement.
 *
 * Deliberately in-process and deliberately lossy: the durable record of a
 * recovery time is the Goal row written at settlement, and losing a hint before
 * then only costs automatic recovery for that one stop.
 */
export class ThreadGoalUsageRecoveryHints {
    nowMs;
    hints = new Map();
    constructor(nowMs) {
        this.nowMs = nowMs;
    }
    /**
     * Fail-open observer for one failed physical provider request.
     *
     * Shaped to be composed with the existing error-reporting hook rather than to
     * replace it, and must never throw: agent-core treats this callback as a pure
     * side-channel.
     */
    observeLLMRequestFailure = (info) => {
        if (info.metricKind !== 'usage_limit')
            return;
        if (!info.turnId)
            return;
        const recoverAtMs = parseProviderUsageRecoveryAtMs(info, this.nowMs());
        if (recoverAtMs === undefined)
            return;
        // A logical call retries before it gives up, so several physical failures
        // can report the same quota. The last observation is the freshest view of
        // the window, so it wins.
        this.hints.delete(info.turnId);
        this.hints.set(info.turnId, {
            sessionId: info.sessionId,
            turnId: info.turnId,
            recoverAtMs,
        });
        while (this.hints.size > MAX_PARKED_HINTS) {
            const oldest = this.hints.keys().next();
            if (oldest.done)
                break;
            this.hints.delete(oldest.value);
        }
    };
    /**
     * Take the recovery time recorded for this Turn, if any.
     *
     * Consuming removes the entry: a hint describes one stop, and re-reading it
     * for a later Turn would schedule a recovery against a quota that may have
     * already returned.
     */
    consume(turnId) {
        const hint = this.hints.get(turnId);
        if (!hint)
            return undefined;
        this.hints.delete(turnId);
        // Re-validate on the way out: the hint may have been parked long enough for
        // its own recovery time to pass, in which case the quota is already back and
        // there is nothing to wait for.
        return normalizeUsageRecoveryAtMs(hint.recoverAtMs, this.nowMs());
    }
    /** Drop every hint for a Session, e.g. when its Goal is cleared. */
    forgetSession(sessionId) {
        for (const [turnId, hint] of this.hints) {
            if (hint.sessionId === sessionId)
                this.hints.delete(turnId);
        }
    }
    /** Test seam: number of parked hints. */
    get size() {
        return this.hints.size;
    }
}
/**
 * Read a trustworthy recovery instant out of a raw provider failure.
 *
 * @internal Exported for focused testing of the provider shapes this understands.
 * Returns `undefined` whenever the provider did not clearly say when the quota
 * returns — that answer means "no automatic recovery", not "try something".
 */
export function parseProviderUsageRecoveryAtMs(info, nowMs) {
    for (const candidate of [info.providerError, info.error]) {
        const fromError = readRecoveryFromErrorObject(candidate, nowMs);
        if (fromError !== undefined)
            return fromError;
    }
    return readRecoveryFromText(info.errorMessage, nowMs);
}
function readRecoveryFromErrorObject(value, nowMs, depth = 0) {
    if (depth > 4 || !isRecord(value))
        return undefined;
    const headers = readHeaders(value);
    const fromHeaders = headers ? readRecoveryFromHeaders(headers, nowMs) : undefined;
    if (fromHeaders !== undefined)
        return fromHeaders;
    const fromFields = firstDefined(RESET_FIELD_NAMES, (name) => toRecoveryAtMs(value[name], nowMs));
    if (fromFields !== undefined)
        return fromFields;
    // Provider SDKs nest the useful payload one or two levels down
    // (`error.error.resets_at`, `error.response.headers`, …). Recurse over the
    // few container keys that carry it rather than walking the whole object.
    return firstDefined(NESTED_ERROR_KEYS, (key) => readRecoveryFromErrorObject(value[key], nowMs, depth + 1));
}
const NESTED_ERROR_KEYS = ['error', 'body', 'response', 'data', 'cause'];
function readRecoveryFromHeaders(headers, nowMs) {
    for (const [name, headerValue] of Object.entries(headers)) {
        if (!RESET_HEADER_SUFFIXES.some((suffix) => name.endsWith(suffix)))
            continue;
        const resolved = toRecoveryAtMs(headerValue, nowMs);
        if (resolved !== undefined)
            return resolved;
    }
    const retryAfter = headers['retry-after'];
    const delays = [toDurationMs(headers['retry-after-ms'], 1), toDurationMs(retryAfter, 1_000)];
    for (const delayMs of delays) {
        if (delayMs === undefined)
            continue;
        const resolved = normalizeUsageRecoveryAtMs(nowMs + delayMs, nowMs);
        if (resolved !== undefined)
            return resolved;
    }
    // An HTTP-date `Retry-After` is already an absolute instant.
    return toRecoveryAtMs(retryAfter, nowMs);
}
function firstDefined(items, read) {
    for (const item of items) {
        const value = read(item);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
/**
 * Last resort: the provider only left the reset time inside its message text.
 *
 * Restricted to an explicit `<field>=<value>` or `"<field>": <value>` shape so
 * an unrelated number in a sentence can never be read as a reset instant.
 */
function readRecoveryFromText(text, nowMs) {
    if (!text)
        return undefined;
    for (const name of RESET_FIELD_NAMES) {
        const pattern = new RegExp(`["']?${name}["']?\\s*[:=]\\s*["']?([^,"'}\\s]+)`, 'iu');
        const matched = pattern.exec(text);
        const resolved = toRecoveryAtMs(matched?.[1], nowMs);
        if (resolved !== undefined)
            return resolved;
    }
    return undefined;
}
/**
 * Interpret one provider value as an absolute Unix ms recovery instant.
 *
 * Accepts Unix seconds, Unix milliseconds and ISO/HTTP dates. Seconds vs.
 * milliseconds is decided by magnitude against the accepted horizon rather than
 * by digit counting, so neither unit can be silently misread.
 */
function toRecoveryAtMs(value, nowMs) {
    if (typeof value === 'number' || typeof value === 'string') {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            const asMillis = normalizeUsageRecoveryAtMs(Math.floor(numeric), nowMs);
            if (asMillis !== undefined)
                return asMillis;
            const asSeconds = normalizeUsageRecoveryAtMs(Math.floor(numeric) * 1_000, nowMs);
            if (asSeconds !== undefined)
                return asSeconds;
            return undefined;
        }
    }
    if (typeof value !== 'string')
        return undefined;
    const parsedDate = Date.parse(value);
    if (Number.isNaN(parsedDate))
        return undefined;
    return normalizeUsageRecoveryAtMs(parsedDate, nowMs);
}
/** Interpret one provider value as a positive relative delay. */
function toDurationMs(value, unitMs) {
    if (typeof value !== 'number' && typeof value !== 'string')
        return undefined;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return undefined;
    const delayMs = Math.floor(numeric * unitMs);
    if (delayMs <= 0 || delayMs > THREAD_GOAL_USAGE_RECOVERY_MAX_HORIZON_MS)
        return undefined;
    return delayMs;
}
function readHeaders(value) {
    const entries = readHeaderEntries(value.headers);
    if (!entries)
        return undefined;
    const normalized = {};
    for (const [name, headerValue] of entries) {
        if (typeof name === 'string')
            normalized[name.toLowerCase()] = headerValue;
    }
    return normalized;
}
/** A `Headers`/`Map`-like object iterates its entries; a plain object is read directly. */
function readHeaderEntries(headers) {
    if (isIterableHeaders(headers))
        return [...headers];
    return isRecord(headers) ? Object.entries(headers) : undefined;
}
function isIterableHeaders(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value.entries === 'function');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=usage-recovery-hint.js.map