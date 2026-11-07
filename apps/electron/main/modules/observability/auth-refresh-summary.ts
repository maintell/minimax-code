/**
 * Outbox allowlist for `auth.refresh_summary`.
 *
 * The event is produced by Main from `@mavis/oauth-core` refresh diagnostics.
 * Only enums, booleans, bounded integers and formatted ids pass this boundary;
 * unknown fields are dropped, so a future producer change cannot leak tokens,
 * headers, bodies, URLs or error messages into persisted telemetry.
 */
export let AUTH_REFRESH_SUMMARY_EVENT = 'auth.refresh_summary';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSPORT_ID_PATTERN = /^oauth-net-[0-9a-z]{1,16}$/;
const SERVER_TRACE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z]{1,64}$/;
const ERROR_CODE_PATTERN = /^[A-Za-z_]{1,64}$/;
const NATIVE_ERROR_CODE_PATTERN = /^(?:E[A-Z0-9]{2,31}|ERR_[A-Z0-9_]{1,64}|UND_ERR_[A-Z0-9_]{1,56}|unknown)$/;
const OBSERVED_ACTION_PATTERN = /^(?:prepare_refresh|stage_credentials|commit_credentials|commit_state|invalidate_state|delete_credentials|restore_state):(?:success|failure|retry)$/;
const ELECTRON_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const MAX_TRANSPORT_IDS = 4;
const MAX_OBSERVED_ACTIONS = 16;
const OUTCOMES = new Set(['success', 'failure']);
const TRIGGERS = new Set(['unauthorized_response', 'min_validity']);
const STATES = new Set([
    'anonymous',
    'authorizing',
    'authenticated',
    'refreshing',
    'scope_upgrade_required',
    'logging_out',
    'logout_pending',
    'expired',
    'error',
    'unknown',
]);
const PHASES = new Set([
    'none',
    'request_created',
    'request_body_finished',
    'headers_received',
    'body_read',
    'grant_validated',
    'credentials_committed',
]);
const CONTENT_TYPES = new Set([
    'application/json',
    'application/problem+json',
    'text/html',
    'text/plain',
    'other',
    'unknown',
]);
const ERROR_SOURCES = new Set([
    'request',
    'response',
    'response_aborted',
    'signal_abort',
    'adapter',
    'body_read',
    'grant_validation',
    'persistence',
]);
const ABORT_CATEGORIES = new Set(['abort_signal', 'timeout_signal', 'unknown']);
const DECISIONS = new Set([
    'refresh_succeeded',
    'invalid_grant_400',
    'refresh_exception_non_invalid_grant',
    'credential_write_failed',
    'session_changed',
    'commit_pending',
    'unknown',
]);
const RESTORE_TARGETS = new Set(['authenticated', 'expired']);
const NON_NEGATIVE_INTEGER_FIELDS = [
    'generation_before',
    'credential_generation_before',
    'generation_attempted',
    'wall_elapsed_ms',
    'monotonic_elapsed_ms',
    'request_created_elapsed_ms',
    'request_body_finished_elapsed_ms',
    'headers_received_elapsed_ms',
    'body_read_elapsed_ms',
    'grant_validated_elapsed_ms',
    'credentials_committed_elapsed_ms',
    'transport_request_count',
    'response_content_length_hint',
    'error_elapsed_ms',
    'persistence_retry_count',
    'recent_execution_gap_ms',
];
const TIMESTAMP_FIELDS = [
    'started_at_ms',
    'ended_at_ms',
    'last_suspend_at_ms',
    'last_resume_at_ms',
    'last_lock_at_ms',
    'last_unlock_at_ms',
    'recent_execution_gap_at_ms',
];
const NULLABLE_BOOLEAN_FIELDS = [
    'headers_received',
    'body_read_succeeded',
    'response_json_parsed',
    'has_access_token',
    'has_refresh_token',
    'refresh_token_changed',
    'grant_validated',
    'network_online_hint_at_start',
    'network_online_hint',
];
const ENUM_FIELDS = [
    ['outcome', OUTCOMES],
    ['refresh_trigger', TRIGGERS],
    ['state_before', STATES],
    ['state_after', STATES],
    ['last_completed_phase', PHASES],
    ['response_content_type', CONTENT_TYPES],
    ['error_source', ERROR_SOURCES],
    ['abort_reason_category', ABORT_CATEGORIES],
    ['decision_reason', DECISIONS],
    ['restore_target_status', RESTORE_TARGETS],
];
const PATTERN_FIELDS = [
    ['correlationId', UUID_PATTERN],
    ['server_trace_id', SERVER_TRACE_ID_PATTERN],
    ['error_name', ERROR_NAME_PATTERN],
    ['thrown_error_name', ERROR_NAME_PATTERN],
    ['error_code', ERROR_CODE_PATTERN],
    ['native_error_code', NATIVE_ERROR_CODE_PATTERN],
    ['electron_version', ELECTRON_VERSION_PATTERN],
];
export function sanitizeAuthRefreshSummaryPayload(payload) {
    const sanitized = { domain: 'auth' };
    if (payload.diagnostic_schema_version === 1)
        sanitized.diagnostic_schema_version = 1;
    if (isPositiveInteger(payload.pid))
        sanitized.pid = payload.pid;
    for (const [field, allowed] of ENUM_FIELDS) {
        const value = payload[field];
        if (typeof value === 'string' && allowed.has(value))
            sanitized[field] = value;
    }
    for (const [field, pattern] of PATTERN_FIELDS) {
        const value = payload[field];
        if (typeof value === 'string' && pattern.test(value))
            sanitized[field] = value;
    }
    for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
        const value = payload[field];
        if (isNonNegativeInteger(value))
            sanitized[field] = value;
    }
    for (const field of TIMESTAMP_FIELDS) {
        const value = payload[field];
        if (isPositiveInteger(value))
            sanitized[field] = value;
    }
    for (const field of NULLABLE_BOOLEAN_FIELDS) {
        const value = payload[field];
        if (typeof value === 'boolean' || value === null)
            sanitized[field] = value;
    }
    if (typeof payload.pending_commit_present === 'boolean') {
        sanitized.pending_commit_present = payload.pending_commit_present;
    }
    // Remaining credential validity can be negative once the token has expired.
    if (isSafeInteger(payload.credential_remaining_ms)) {
        sanitized.credential_remaining_ms = payload.credential_remaining_ms;
    }
    if (payload.generation_after === null || isNonNegativeInteger(payload.generation_after)) {
        sanitized.generation_after = payload.generation_after;
    }
    if (payload.request_timeout_configured_ms === null)
        sanitized.request_timeout_configured_ms = null;
    for (const field of ['http_status_received', 'error_http_status']) {
        const value = payload[field];
        if (isSafeInteger(value) && value >= 100 && value <= 999)
            sanitized[field] = value;
    }
    if (payload.proxy_mode_hint === 'unknown')
        sanitized.proxy_mode_hint = 'unknown';
    // Arrays are flattened to bounded strings so every telemetry sink can index them.
    const transportIds = boundedList(payload.transport_request_ids, TRANSPORT_ID_PATTERN, MAX_TRANSPORT_IDS);
    if (transportIds !== undefined)
        sanitized.transport_request_ids = transportIds;
    const actions = boundedList(payload.observed_actions, OBSERVED_ACTION_PATTERN, MAX_OBSERVED_ACTIONS);
    if (actions !== undefined)
        sanitized.observed_actions = actions;
    return sanitized;
}
// Accepts the producer's array and the joined string persisted by an earlier
// pass: the outbox sanitizes again when replaying records from disk, so this
// must be idempotent. Every item is still matched against the same pattern.
function boundedList(value, pattern, max) {
    const items = Array.isArray(value)
        ? value.slice(0, max)
        : typeof value === 'string'
            ? value.split(',', max)
            : undefined;
    if (!items)
        return undefined;
    const accepted = [];
    for (const item of items) {
        if (typeof item === 'string' && pattern.test(item))
            accepted.push(item);
    }
    return accepted.join(',');
}
function isSafeInteger(value) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}
function isNonNegativeInteger(value) {
    return isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
    return isSafeInteger(value) && value > 0;
}
