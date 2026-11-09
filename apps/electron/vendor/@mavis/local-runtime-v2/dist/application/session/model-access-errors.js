import { LocalModelProviderError } from '../../service/model-system/index.js';
import { AppError } from '../errors.js';
// Fixed safe codes produced by the model-access owner; anything else collapses to a generic code.
const ERROR_STATUS = {
    ...codes(400, [
        'trust_required',
        'invalid_package',
        'package_too_large',
        'unsupported_platform',
        'dependency_unsupported',
        'login_invalid',
        'borrow_invalid',
        'api_scan_invalid',
        'request_invalid',
        'unsupported_capability',
        'invalid_manifest',
        'incompatible_sdk',
        'invalid_handlers',
    ]),
    ...codes(400, ['package_name_reserved']),
    ...codes(404, ['dev_session_missing', 'dev_request_missing']),
    ...codes(409, ['package_name_taken']),
    ...codes(403, [
        'subscription_disabled',
        'capability_disabled',
        'explicit_action_required',
        'import_disabled',
        'remote_disabled',
        'package_revoked',
        'service_disabled',
        'provider_disabled',
        'official_package_managed',
    ]),
    ...codes(404, [
        'installation_missing',
        'login_missing',
        'login_unavailable',
        'borrow_unavailable',
    ]),
    ...codes(409, [
        'binding_conflict',
        'package_changed',
        'integrity_failed',
        'pending_restart',
        'profile_busy',
        'profile_mismatch',
        'login_busy',
        'login_not_waiting',
        'login_expired',
        'login_cancelled',
        'login_invalidated',
        'borrow_limit',
        'borrow_expired',
        'api_scan_limit',
        'api_candidate_stale',
        'provider_conflict',
        'operation_invalidated',
        'credential_schema_mismatch',
        'request_identity_changed',
        'request_signin_revoked',
        'request_renewal_commit_failed',
        'request_busy',
    ]),
    ...codes(502, [
        'login_failed',
        'borrow_failed',
        'api_scan_failed',
        'request_failed',
        'request_expired',
        'request_renewal_network',
        'activation_failed',
        'secret_missing',
        'secret_invalid',
        'credential_invalid',
        'credential_state_invalid',
    ]),
    ...codes(503, [
        'dependency_unavailable',
        'dependency_missing',
        'service_closed',
        'login_closed',
        'borrow_closed',
        'api_scan_closed',
        'request_closed',
        'request_unavailable',
        'api_scan_unavailable',
        'secret_store_unavailable',
        'secret_store_locked_or_denied',
        'secret_store_timeout',
        'secret_store_busy',
        'storage_failed',
    ]),
};
function codes(status, values) {
    return Object.fromEntries(values.map((code) => [code, status]));
}
function domainErrorCode(error) {
    if (!(error instanceof Error) || !error.name.startsWith('ModelAccess'))
        return undefined;
    const code = error.code;
    return typeof code === 'string' && Object.hasOwn(ERROR_STATUS, code) ? code : undefined;
}
/** Per-item error code for list results; never an exception message. */
export function safeErrorCode(error) {
    if (error instanceof AppError)
        return error.key;
    if (error instanceof LocalModelProviderError)
        return error.code;
    return domainErrorCode(error) ?? 'failed';
}
export function toModelAccessAppError(error) {
    if (error instanceof AppError)
        return error;
    if (error instanceof LocalModelProviderError) {
        return new AppError(error.status, error.code, error.message);
    }
    const code = domainErrorCode(error);
    if (code) {
        // Remote refusals carry only a validated machine reason (^[a-z][a-z0-9_]{0,63}$).
        const reason = error.reason;
        const message = typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(reason)
            ? `${code}:${reason}`
            : code;
        return new AppError(ERROR_STATUS[code], `MODEL_ACCESS_${code.toUpperCase()}`, message);
    }
    return new AppError(500, 'MODEL_ACCESS_FAILED', 'Model access operation failed');
}
//# sourceMappingURL=model-access-errors.js.map