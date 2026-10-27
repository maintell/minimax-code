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