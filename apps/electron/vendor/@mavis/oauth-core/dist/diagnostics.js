import { AsyncLocalStorage } from 'node:async_hooks';
const writes = new AsyncLocalStorage();
/** Preserve the original exception in-process, never serialize its message/stack/tokens. */
export class AuthCredentialSaveError extends Error {
    authDiagnostic;
    code = 'AUTH_CREDENTIAL_SAVE_FAILED';
    constructor(authDiagnostic, cause) {
        super('Failed to save authentication credentials. Please retry.', { cause });
        this.authDiagnostic = authDiagnostic;
        this.name = 'AuthCredentialSaveError';
    }
}
export function reportAuthDiagnostic(context, observer, outcome, error, retryCount = 0) {
    const diagnostic = {
        ...context,
        pid: process.pid,
        timeMs: Date.now(),
        outcome,
        retryCount,
        ...safeErrorFields(error),
        ...nativeErrorCodeField(error),
    };
    try {
        observer?.(diagnostic);
    }
    catch {
        /* Logging must not change credential commits. */
    }
    return diagnostic;
}
export function recordAuthWriteRetry(error, retryCount) {
    const current = writes.getStore();
    if (!current)
        return;
    current.retryCount = retryCount;
    reportAuthDiagnostic(current.context, current.observer, 'retry', error, retryCount);
}
export async function persistAuth(context, observer, operation) {
    return writes.run({ context, observer, retryCount: 0 }, async () => {
        try {
            const result = await operation();
            reportAuthDiagnostic(context, observer, 'success', undefined, writes.getStore()?.retryCount);
            return result;
        }
        catch (cause) {
            const diagnostic = reportAuthDiagnostic(context, observer, 'failure', cause, writes.getStore()?.retryCount);
            throw new AuthCredentialSaveError(diagnostic, cause);
        }
    });
}
// Chromium reports network failures only inside Error.message, e.g.
// `net::ERR_EMPTY_RESPONSE`. Only the strict token is kept; the message is not.
const ELECTRON_NET_ERROR_PATTERN = /\bnet::(ERR_[A-Z0-9_]{1,64})\b/u;
// Node system errors (ECONNRESET), Node internals (ERR_*), undici (UND_ERR_*).
const NATIVE_ERROR_CODE_PATTERN = /^(?:E[A-Z0-9]{2,31}|ERR_[A-Z0-9_]{1,60}|UND_ERR_[A-Z0-9_]{1,56})$/u;
const MAX_NATIVE_ERROR_MESSAGE_SCAN = 2_048;
const MAX_NATIVE_ERROR_CAUSE_DEPTH = 3;
/**
 * Extract a bounded native error code without retaining the error or its
 * message. Reading hostile getters is isolated; unrecognized errors are
 * reported as `unknown`, never as their free-form message.
 */
export function extractNativeErrorCode(error) {
    let current = error;
    for (let depth = 0; depth < MAX_NATIVE_ERROR_CAUSE_DEPTH && current && typeof current === 'object'; depth += 1) {
        const found = readNativeErrorCode(current);
        if (found)
            return found;
        current = readErrorProperty(current, 'cause');
    }
    return 'unknown';
}
function nativeErrorCodeField(error) {
    try {
        if (error === undefined || error === null)
            return {};
        // OAuth protocol errors already carry the received HTTP status and code.
        if (typeof readErrorProperty(error, 'httpStatus') === 'number')
            return {};
        return { nativeErrorCode: extractNativeErrorCode(error) };
    }
    catch {
        return {};
    }
}
function readNativeErrorCode(value) {
    const message = readErrorProperty(value, 'message');
    if (typeof message === 'string') {
        const match = ELECTRON_NET_ERROR_PATTERN.exec(message.slice(0, MAX_NATIVE_ERROR_MESSAGE_SCAN));
        if (match?.[1])
            return match[1];
    }
    const code = readErrorProperty(value, 'code');
    return typeof code === 'string' && NATIVE_ERROR_CODE_PATTERN.test(code) ? code : undefined;
}
function readErrorProperty(value, key) {
    if (!value || typeof value !== 'object')
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
function safeErrorFields(error) {
    if (!error || typeof error !== 'object')
        return {};
    const e = error;
    return {
        ...(typeof e.name === 'string' && /^[A-Za-z]{1,64}$/u.test(e.name)
            ? { errorName: e.name }
            : {}),
        ...(typeof e.code === 'string' && /^[A-Za-z_]{1,64}$/u.test(e.code) ? { code: e.code } : {}),
        ...(typeof e.errno === 'number' && Number.isFinite(e.errno) ? { errno: e.errno } : {}),
        ...(typeof e.syscall === 'string' && /^[a-z]{1,32}$/u.test(e.syscall)
            ? { syscall: e.syscall }
            : {}),
        ...(typeof e.httpStatus === 'number' && Number.isInteger(e.httpStatus)
            ? { httpStatus: e.httpStatus }
            : {}),
    };
}
//# sourceMappingURL=diagnostics.js.map