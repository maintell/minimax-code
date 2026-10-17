/** 登录诊断只传递固定错误码，不传递异常文本、URL 或凭据。 */
const OAUTH_ERROR_CODES = new Set([
    'invalid_client',
    'invalid_request',
    'invalid_grant',
    'invalid_scope',
    'unauthorized_client',
    'unsupported_grant_type',
    'access_denied',
    'expired_token',
    'temporarily_unavailable',
    'server_error',
    'invalid_device_authorization_response',
    'invalid_json_response',
    'invalid_token_response',
    'device_authorization_failed',
    'oauth_request_failed',
]);
const LOCAL_ERROR_CODES = new Set([
    'no_default_browser',
    'browser_open_failed',
    'login_failed',
    'login_unavailable',
    'browser_api_unavailable',
    'ipc_rejected',
    'clipboard_write_failed',
    'cancel_failed',
    'cancelled',
    'network_error',
    'timeout',
    'auth_session_changed',
]);
const NATIVE_ERROR_CODES = new Set([
    '0x483',
    '0x80070483',
    '0x800401f5',
    'ENOENT',
    'EACCES',
    'EPERM',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_TIMED_OUT',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_CERT_AUTHORITY_INVALID',
    'ERR_CERT_DATE_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
]);
const ERROR_TYPES = new Set([
    'Error',
    'TypeError',
    'AbortError',
    'TimeoutError',
    'OAuthProtocolError',
    'AuthLoginCancelledError',
    'AuthRequiredError',
    'AuthSessionChangedError',
    'AuthScopeUpgradeRequiredError',
    'AuthResourceContractMismatchError',
    'AuthDomainConflictError',
    'CredentialRecordCorruptError',
    'CredentialStorePermissionError',
]);
function record(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
/** IPC 消费端再次白名单化，额外字段和未知错误文本均丢弃。 */
export function sanitizeDesktopLoginDiagnostics(value, fallback) {
    const input = record(value);
    const errorCode = typeof input.errorCode === 'string' &&
        (OAUTH_ERROR_CODES.has(input.errorCode) || LOCAL_ERROR_CODES.has(input.errorCode))
        ? input.errorCode
        : LOCAL_ERROR_CODES.has(fallback)
            ? fallback
            : 'login_failed';
    return {
        errorCode,
        ...(typeof input.nativeErrorCode === 'string' && NATIVE_ERROR_CODES.has(input.nativeErrorCode)
            ? { nativeErrorCode: input.nativeErrorCode }
            : {}),
        ...(Number.isInteger(input.httpStatus) &&
            Number(input.httpStatus) >= 100 &&
            Number(input.httpStatus) <= 599
            ? { httpStatus: Number(input.httpStatus) }
            : {}),
        ...(typeof input.errorType === 'string' && ERROR_TYPES.has(input.errorType)
            ? { errorType: input.errorType }
            : {}),
    };
}
/** 在 Main 丢失 Error 属性前提取诊断；最多读取三层 cause。 */
export function classifyDesktopLoginError(error, fallback, platform) {
    const original = typeof error === 'string' ? { message: error } : record(error);
    let errorCode = fallback;
    let nativeErrorCode;
    let current = original;
    for (let depth = 0; depth < 3; depth += 1) {
        if (typeof current.code === 'string') {
            if (OAUTH_ERROR_CODES.has(current.code))
                errorCode = current.code;
            if (NATIVE_ERROR_CODES.has(current.code))
                nativeErrorCode = current.code;
        }
        const message = typeof current.message === 'string' ? current.message : '';
        const nativeMatch = message.match(/net::(ERR_[A-Z_]+)\b/)?.[1] ??
            message.match(/\((0x[0-9a-f]+)\)\s*\.?$/i)?.[1]?.toLowerCase();
        if (nativeMatch && NATIVE_ERROR_CODES.has(nativeMatch))
            nativeErrorCode = nativeMatch;
        current = record(current.cause);
    }
    if (platform === 'win32' &&
        nativeErrorCode &&
        ['0x483', '0x80070483', '0x800401f5'].includes(nativeErrorCode)) {
        errorCode = 'no_default_browser';
    }
    else if (original.name === 'AuthLoginCancelledError' || original.name === 'AbortError') {
        errorCode = 'cancelled';
    }
    else if (original.name === 'AuthSessionChangedError') {
        errorCode = 'auth_session_changed';
    }
    else if (original.name === 'TimeoutError' ||
        nativeErrorCode?.includes('TIMED_OUT') ||
        nativeErrorCode?.includes('TIMEOUT') ||
        nativeErrorCode === 'ETIMEDOUT') {
        errorCode = 'timeout';
    }
    else if (nativeErrorCode &&
        !['ENOENT', 'EACCES', 'EPERM'].includes(nativeErrorCode) &&
        fallback === 'login_failed' &&
        errorCode === fallback) {
        errorCode = 'network_error';
    }
    return sanitizeDesktopLoginDiagnostics({
        errorCode,
        nativeErrorCode,
        httpStatus: original.httpStatus,
        errorType: original.name,
    }, fallback);
}
//# sourceMappingURL=desktop-login-diagnostics.js.map