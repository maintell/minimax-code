const RETRYABLE_CODES = new Set([
    'ssh_host_unreachable',
    'host_unreachable',
    'unreachable',
    'runtime_connection_lost',
    'ssh_command_timeout',
    'command_timeout',
    'app_server_initialize_timeout',
    'host_connection_timeout',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
]);
const ACTION_REQUIRED_CODES = new Set([
    'credential_unavailable',
    'credential_storage_unavailable',
    'ssh_not_found',
    'ssh_auth_failed',
    'auth_failed',
    'ssh_host_key_untrusted',
    'host_key_untrusted',
    'ssh_algorithm_unsupported',
    'ssh_connection_rejected',
    'remote_mcode_not_found',
    'remote_mcode_incompatible',
    'remote_mcode_start_failed',
    'remote_mcode_profile_mismatch',
    'cli_missing',
    'cli_incompatible',
    'cli_version_mismatch',
    'installer_unavailable',
    'install_failed',
    'cli_start_failed',
    'protocol_mismatch',
    'app_server_protocol_mismatch',
    'app_server_protocol_error',
    'ssh_channel_invalid',
    'channel_invalid',
    'invalid_input',
    'host_not_configured',
    'connection_not_found',
    'identity_file_not_found',
]);
const STOPPED_CODES = new Set([
    'ssh_cancelled',
    'cancelled',
    'connection_disabled',
    'ssh_connection_disabled',
    'runtime_connection_stopped',
    'host_connection_disposed',
]);
/** Unknown failures get at most three attempts, including the first failure. */
export function classifyHostRecoveryError(error, unknownFailures = 1) {
    const record = typeof error === 'object' && error !== null ? error : {};
    const code = 'code' in record && typeof record.code === 'string'
        ? record.code
        : 'name' in record && record.name === 'AbortError'
            ? 'ssh_cancelled'
            : 'unknown_error';
    const message = 'message' in record && typeof record.message === 'string'
        ? record.message
        : 'The SSH connection failed for an unknown reason.';
    const disposition = STOPPED_CODES.has(code)
        ? 'stopped'
        : ACTION_REQUIRED_CODES.has(code)
            ? 'action_required'
            : RETRYABLE_CODES.has(code) || unknownFailures < 3
                ? 'retry'
                : 'action_required';
    return {
        code,
        message,
        disposition,
        ...('details' in record && record.details
            ? { details: record.details }
            : {}),
    };
}
export function isUnknownHostRecoveryError(error) {
    const { code } = classifyHostRecoveryError(error);
    return !RETRYABLE_CODES.has(code) && !ACTION_REQUIRED_CODES.has(code) && !STOPPED_CODES.has(code);
}
/** Backoff starts after failure completion; after five minutes offline use a minute. */
export function hostRecoveryDelayMs(failures, offlineMs, random = Math.random) {
    const base = offlineMs >= 300000
        ? 60000
        : [1000, 2000, 4000, 8000, 16000, 30000][Math.min(5, Math.max(0, failures - 1))];
    // ±20% jitter, bounded even when a supplied random source is outside [0, 1].
    return Math.round(base * (0.8 + Math.min(1, Math.max(0, random())) * 0.4));
}
