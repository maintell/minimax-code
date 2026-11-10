import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { extractNativeErrorCode } from './diagnostics.js';
/**
 * Read-only refresh diagnostics. Nothing in this module may change a refresh
 * request, its result, its exceptions or the persisted auth state: every entry
 * point swallows its own failures and keeps only enums, booleans, bounded
 * numbers and formatted ids. Tokens, headers, bodies and messages are never
 * retained.
 */
export const AUTH_REFRESH_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const AUTH_REFRESH_PHASES = [
    'request_created',
    'request_body_finished',
    'headers_received',
    'body_read',
    'grant_validated',
    'credentials_committed',
];
const OBSERVED_STATES = new Set([
    'anonymous',
    'authorizing',
    'authenticated',
    'refreshing',
    'scope_upgrade_required',
    'logging_out',
    'logout_pending',
    'expired',
    'error',
]);
const KNOWN_CONTENT_TYPES = new Set([
    'application/json',
    'application/problem+json',
    'text/html',
    'text/plain',
]);
const PHASE_RANK = {
    request_created: 1,
    request_body_finished: 2,
    headers_received: 3,
    body_read: 4,
    grant_validated: 5,
    credentials_committed: 6,
};
// Header names already used by this repository for server trace ids. The
// account gateway is not guaranteed to send any of them.
const SERVER_TRACE_HEADERS = ['trace-id', 'traceid', 'x-trace-id'];
const SERVER_TRACE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/u;
const CONTENT_LENGTH_PATTERN = /^\d{1,12}$/u;
const ERROR_NAME_PATTERN = /^[A-Za-z]{1,64}$/u;
const MAX_TRANSPORT_IDS = 4;
const MAX_OBSERVED_ACTIONS = 16;
let transportSequence = 0;
const refreshTraceScope = new AsyncLocalStorage();
export class AuthRefreshTrace {
    correlationId;
    start;
    startedMonoMs;
    ended = false;
    lastPhase;
    phaseElapsedMs = {};
    transportIds = [];
    transportCount = 0;
    headersReceived = null;
    httpStatus;
    contentType;
    contentLength;
    serverTraceId;
    bodyReadSucceeded = null;
    jsonParsed = null;
    hasAccessToken = null;
    hasRefreshToken = null;
    refreshTokenChanged = null;
    grantValidated = null;
    errorSource;
    errorElapsedMs;
    nativeErrorCode;
    abortCategory;
    refreshResponseError = {};
    decision;
    restoreTarget;
    actions = [];
    persistenceRetries = 0;
    stateAfter;
    generationAfter;
    constructor(start) {
        this.correlationId = start.correlationId;
        this.startedMonoMs = performance.now();
        this.start = {
            event: 'auth.refresh_start',
            diagnostic_schema_version: AUTH_REFRESH_DIAGNOSTIC_SCHEMA_VERSION,
            correlationId: start.correlationId,
            pid: process.pid,
            refresh_trigger: start.trigger,
            state_before: observedState(start.stateBefore),
            generation_before: start.generationBefore,
            credential_generation_before: start.credentialGenerationBefore,
            generation_attempted: start.generationAttempted,
            credential_remaining_ms: boundedInteger(start.credentialRemainingMs),
            started_at_ms: Date.now(),
        };
    }
    startEvent() {
        return { ...this.start };
    }
    createTransportObserver() {
        transportSequence = (transportSequence + 1) % Number.MAX_SAFE_INTEGER;
        const transportRequestId = `oauth-net-${transportSequence.toString(36)}`;
        this.guard(() => {
            this.transportCount += 1;
            if (this.transportIds.length < MAX_TRANSPORT_IDS)
                this.transportIds.push(transportRequestId);
        });
        return {
            transportRequestId,
            requestCreated: () => this.guard(() => this.markPhase('request_created')),
            requestBodyFinished: () => this.guard(() => this.markPhase('request_body_finished')),
            headersReceived: (info) => this.guard(() => this.recordHeaders(info)),
            bodyRead: () => this.guard(() => {
                if (this.bodyReadSucceeded === null)
                    this.bodyReadSucceeded = true;
                this.markPhase('body_read');
            }),
            failed: (source, error) => this.guard(() => this.recordTransportFailure(source, error)),
        };
    }
    /** Response metadata only: never reads, clones or tees the body. */
    recordResponse(response) {
        this.guard(() => {
            if (!response || typeof response !== 'object')
                return;
            const value = response;
            const headers = value.headers;
            const read = (name) => {
                try {
                    return typeof headers?.get === 'function' ? headers.get(name) : undefined;
                }
                catch {
                    return undefined;
                }
            };
            this.recordHeaders({
                status: value.status,
                contentType: read('content-type'),
                contentLength: read('content-length'),
            });
            if (this.serverTraceId === undefined) {
                for (const name of SERVER_TRACE_HEADERS) {
                    const candidate = read(name);
                    if (typeof candidate === 'string' && SERVER_TRACE_ID_PATTERN.test(candidate)) {
                        this.serverTraceId = candidate;
                        break;
                    }
                }
            }
        });
    }
    recordBodyParsed() {
        this.guard(() => {
            this.bodyReadSucceeded = true;
            this.jsonParsed = true;
            this.markPhase('body_read');
        });
    }
    /** Called from the existing body-read catch; the caller keeps its fallback. */
    recordBodyFailure(error) {
        this.guard(() => {
            this.jsonParsed = false;
            // A SyntaxError means the stream ended and only JSON parsing failed.
            if (readName(error) === 'SyntaxError') {
                if (this.bodyReadSucceeded === null)
                    this.bodyReadSucceeded = true;
                this.markPhase('body_read');
            }
            else {
                this.bodyReadSucceeded = false;
            }
            this.recordError('body_read', error);
        });
    }
    /** Field presence from the response body only; a reused fallback RT is not "present". */
    recordGrantFields(body, previousRefreshToken) {
        this.guard(() => {
            if (!body || typeof body !== 'object')
                return;
            const record = body;
            const accessToken = record.access_token;
            const refreshToken = record.refresh_token;
            this.hasAccessToken = typeof accessToken === 'string' && accessToken.length > 0;
            this.hasRefreshToken = typeof refreshToken === 'string' && refreshToken.length > 0;
            this.refreshTokenChanged =
                this.hasRefreshToken && typeof previousRefreshToken === 'string'
                    ? refreshToken !== previousRefreshToken
                    : null;
        });
    }
    /** Tee of the existing persistence/refresh_response diagnostics for this transaction. */
    observeDiagnostic(event) {
        this.guard(() => {
            if (event.correlationId !== this.correlationId)
                return;
            if (event.outcome === 'retry') {
                this.persistenceRetries += 1;
                return;
            }
            if (event.phase === 'refresh_response') {
                if (event.outcome === 'success') {
                    this.grantValidated = true;
                    this.markPhase('grant_validated');
                }
                else {
                    this.refreshResponseError = {
                        ...(event.errorName ? { errorName: event.errorName } : {}),
                        ...(event.code ? { code: event.code } : {}),
                        ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
                    };
                    if (event.nativeErrorCode && this.nativeErrorCode === undefined) {
                        this.nativeErrorCode = event.nativeErrorCode;
                    }
                }
                return;
            }
            if (this.actions.length < MAX_OBSERVED_ACTIONS) {
                this.actions.push(`${event.phase}:${event.outcome}`);
            }
            if (event.outcome === 'failure') {
                if (this.errorSource === undefined) {
                    this.errorSource = 'persistence';
                    this.errorElapsedMs = this.elapsed();
                    if (event.nativeErrorCode)
                        this.nativeErrorCode = event.nativeErrorCode;
                }
                return;
            }
            switch (event.phase) {
                case 'prepare_refresh':
                    this.setStateAfter('refreshing', event.generation);
                    break;
                case 'commit_credentials':
                    this.markPhase('credentials_committed');
                    break;
                case 'commit_state':
                    this.setStateAfter('authenticated', event.generation);
                    break;
                case 'restore_state':
                    this.setStateAfter(this.restoreTarget ?? 'unknown', this.start.generation_before);
                    break;
                case 'invalidate_state':
                case 'delete_credentials':
                    this.setStateAfter('anonymous', event.generation);
                    break;
                default:
                    break;
            }
        });
    }
    recordDecision(reason, restoreTarget) {
        this.guard(() => {
            if (this.decision === undefined)
                this.decision = reason;
            if (restoreTarget)
                this.restoreTarget = restoreTarget;
        });
    }
    finish(outcome, details) {
        if (this.ended)
            return undefined;
        this.ended = true;
        try {
            const endedAtMs = Date.now();
            const responseFailed = outcome === 'failure' && this.grantValidated !== true;
            // A rejected adapter Promise is a fetch failure without a Response.
            const headersReceived = this.headersReceived ?? (responseFailed && this.jsonParsed === null ? false : null);
            if (responseFailed && this.jsonParsed === true && this.grantValidated === null) {
                this.grantValidated = false;
                if (this.errorSource === undefined) {
                    this.errorSource = 'grant_validation';
                    this.errorElapsedMs = this.elapsed();
                }
            }
            if (responseFailed && this.errorSource === undefined) {
                this.errorSource = 'adapter';
                this.errorElapsedMs = this.elapsed();
            }
            if (outcome === 'failure' && this.nativeErrorCode === undefined && !this.hasHttpEvidence()) {
                this.nativeErrorCode = extractNativeErrorCode(details.thrownError);
            }
            const thrownErrorName = outcome === 'failure' ? readName(details.thrownError) : undefined;
            const summary = {
                ...this.start,
                event: 'auth.refresh_summary',
                outcome,
                ended_at_ms: endedAtMs,
                wall_elapsed_ms: Math.max(0, endedAtMs - this.start.started_at_ms),
                monotonic_elapsed_ms: this.elapsed(),
                request_timeout_configured_ms: null,
                last_completed_phase: this.lastPhase ?? 'none',
                ...this.phaseFields(),
                transport_request_ids: [...this.transportIds],
                transport_request_count: this.transportCount,
                headers_received: headersReceived,
                ...(this.httpStatus !== undefined ? { http_status_received: this.httpStatus } : {}),
                ...(this.contentType ? { response_content_type: this.contentType } : {}),
                ...(this.contentLength !== undefined
                    ? { response_content_length_hint: this.contentLength }
                    : {}),
                ...(this.serverTraceId ? { server_trace_id: this.serverTraceId } : {}),
                body_read_succeeded: this.bodyReadSucceeded,
                response_json_parsed: this.jsonParsed,
                has_access_token: this.hasAccessToken,
                has_refresh_token: this.hasRefreshToken,
                refresh_token_changed: this.refreshTokenChanged,
                grant_validated: this.grantValidated,
                ...(this.errorSource ? { error_source: this.errorSource } : {}),
                ...(this.errorElapsedMs !== undefined ? { error_elapsed_ms: this.errorElapsedMs } : {}),
                ...(this.refreshResponseError.errorName
                    ? { error_name: this.refreshResponseError.errorName }
                    : {}),
                ...(this.refreshResponseError.code ? { error_code: this.refreshResponseError.code } : {}),
                ...(this.refreshResponseError.httpStatus !== undefined
                    ? { error_http_status: this.refreshResponseError.httpStatus }
                    : {}),
                ...(this.nativeErrorCode ? { native_error_code: this.nativeErrorCode } : {}),
                ...(this.abortCategory ? { abort_reason_category: this.abortCategory } : {}),
                ...(thrownErrorName ? { thrown_error_name: thrownErrorName } : {}),
                decision_reason: outcome === 'success'
                    ? 'refresh_succeeded'
                    : (this.decision ?? details.fallbackDecision ?? 'unknown'),
                ...(this.restoreTarget ? { restore_target_status: this.restoreTarget } : {}),
                observed_actions: [...this.actions],
                persistence_retry_count: this.persistenceRetries,
                state_after: this.stateAfter ?? 'unknown',
                generation_after: this.generationAfter ?? null,
                pending_commit_present: details.pendingCommitPresent,
            };
            return summary;
        }
        catch {
            return undefined;
        }
    }
    hasHttpEvidence() {
        return this.headersReceived === true || this.refreshResponseError.httpStatus !== undefined;
    }
    recordHeaders(info) {
        this.headersReceived = true;
        this.markPhase('headers_received');
        if (this.httpStatus === undefined &&
            typeof info.status === 'number' &&
            Number.isInteger(info.status) &&
            info.status >= 100 &&
            info.status <= 999) {
            this.httpStatus = info.status;
        }
        if (this.contentType === undefined)
            this.contentType = normalizeContentType(info.contentType);
        if (this.contentLength === undefined) {
            const length = singleHeaderValue(info.contentLength);
            if (typeof length === 'string' && CONTENT_LENGTH_PATTERN.test(length)) {
                this.contentLength = Number(length);
            }
            else if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
                this.contentLength = length;
            }
        }
    }
    recordTransportFailure(source, error) {
        if (source === 'signal_abort' && this.abortCategory === undefined) {
            const name = readName(error);
            this.abortCategory =
                name === 'TimeoutError'
                    ? 'timeout_signal'
                    : name === 'AbortError'
                        ? 'abort_signal'
                        : 'unknown';
        }
        if (source !== 'signal_abort' && this.headersReceived === true) {
            // The stream failed after headers; the body was not completely read.
            if (this.bodyReadSucceeded === null)
                this.bodyReadSucceeded = false;
        }
        if (this.headersReceived === null && source !== 'response' && source !== 'response_aborted') {
            this.headersReceived = false;
        }
        this.recordError(source, error);
    }
    recordError(source, error) {
        if (this.errorSource !== undefined)
            return;
        this.errorSource = source;
        this.errorElapsedMs = this.elapsed();
        // Extract immediately; the error object itself is not kept.
        this.nativeErrorCode = extractNativeErrorCode(error);
    }
    markPhase(phase) {
        if (this.phaseElapsedMs[phase] === undefined)
            this.phaseElapsedMs[phase] = this.elapsed();
        if (!this.lastPhase || PHASE_RANK[phase] > PHASE_RANK[this.lastPhase])
            this.lastPhase = phase;
    }
    phaseFields() {
        const fields = {};
        for (const phase of AUTH_REFRESH_PHASES) {
            const value = this.phaseElapsedMs[phase];
            if (value !== undefined)
                fields[`${phase}_elapsed_ms`] = value;
        }
        return fields;
    }
    setStateAfter(state, generation) {
        this.stateAfter = state;
        this.generationAfter = Number.isSafeInteger(generation) ? generation : null;
    }
    elapsed() {
        return Math.max(0, Math.round(performance.now() - this.startedMonoMs));
    }
    guard(operation) {
        if (this.ended)
            return;
        try {
            operation();
        }
        catch {
            /* Diagnostics must never affect the refresh. */
        }
    }
}
/** Bind a refresh trace to the async call chain of one operation. */
export function runWithAuthRefreshTrace(trace, operation) {
    return trace ? refreshTraceScope.run(trace, operation) : operation();
}
/**
 * Capture the current refresh transaction synchronously when an HTTP adapter
 * call starts. Returns `undefined` outside a refresh, so login, device polling,
 * revoke and unrelated requests get no OAuth refresh diagnostics.
 */
export function captureAuthTransportObserver() {
    try {
        return refreshTraceScope.getStore()?.createTransportObserver();
    }
    catch {
        return undefined;
    }
}
export function recordAuthRefreshResponse(response) {
    currentTrace()?.recordResponse(response);
}
export function recordAuthRefreshBodyParsed() {
    currentTrace()?.recordBodyParsed();
}
export function recordAuthRefreshBodyFailure(error) {
    currentTrace()?.recordBodyFailure(error);
}
export function recordAuthRefreshGrantFields(body, previousRefreshToken) {
    currentTrace()?.recordGrantFields(body, previousRefreshToken);
}
function currentTrace() {
    try {
        return refreshTraceScope.getStore();
    }
    catch {
        return undefined;
    }
}
function observedState(value) {
    return typeof value === 'string' && OBSERVED_STATES.has(value)
        ? value
        : 'unknown';
}
function normalizeContentType(value) {
    const header = singleHeaderValue(value);
    if (typeof header !== 'string' || header.length === 0)
        return 'unknown';
    const mime = header.slice(0, 256).split(';', 1)[0]?.trim().toLowerCase() ?? '';
    return KNOWN_CONTENT_TYPES.has(mime)
        ? mime
        : 'other';
}
function singleHeaderValue(value) {
    if (Array.isArray(value))
        return value.length === 1 ? value[0] : undefined;
    return value;
}
function readName(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    try {
        const name = error.name;
        return typeof name === 'string' && ERROR_NAME_PATTERN.test(name) ? name : undefined;
    }
    catch {
        return undefined;
    }
}
function boundedInteger(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)));
}
//# sourceMappingURL=refresh-diagnostics.js.map