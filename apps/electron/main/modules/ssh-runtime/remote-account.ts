const states = new Set([
    'login_required',
    'authorizing',
    'authenticated',
    'reauthentication_required',
    'temporarily_unavailable',
]);
/** Allowlist public fields before forwarding an app-server account result to Renderer. */
export function decodeRemoteAccount(value) {
    if (!isRecord(value) ||
        !states.has(value.state) ||
        !Number.isSafeInteger(value.generation) ||
        value.generation < 0) {
        throw new Error('The remote account response is invalid.');
    }
    const account = {
        state: value.state,
        generation: value.generation,
    };
    if (value.pendingLogin !== undefined)
        account.pendingLogin = decodeRemoteLogin(value.pendingLogin);
    if (isRecord(value.failure) &&
        typeof value.failure.code === 'string' &&
        typeof value.failure.message === 'string' &&
        typeof value.failure.retryable === 'boolean') {
        account.failure = {
            code: value.failure.code,
            message: value.failure.message,
            retryable: value.failure.retryable,
        };
    }
    return account;
}
export function decodeRemoteLogin(value) {
    if (!isRecord(value) ||
        value.state !== 'authorizing' ||
        typeof value.loginId !== 'string' ||
        !value.loginId ||
        typeof value.userCode !== 'string' ||
        !value.userCode ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        value.expiresAtMs <= 0) {
        throw new Error('The remote login response is invalid.');
    }
    return {
        loginId: value.loginId,
        userCode: value.userCode,
        expiresAtMs: value.expiresAtMs,
        verificationUri: verificationUrl(value.verificationUri),
        ...(value.verificationUriComplete === undefined
            ? {}
            : {
                verificationUriComplete: verificationUrl(value.verificationUriComplete),
            }),
    };
}
function verificationUrl(value) {
    if (typeof value !== 'string')
        throw new Error('The remote verification URL is invalid.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('The remote verification URL must use HTTPS.');
    }
    return url.toString();
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
