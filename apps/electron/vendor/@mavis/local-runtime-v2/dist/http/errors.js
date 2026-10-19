import { AppError } from '../application/errors.js';
export { AppError, NotImplementedError } from '../application/errors.js';
/** Unknown failures never leak internals to the response body. */
export function toErrorBody(err) {
    if (err instanceof AppError) {
        return {
            code: err.status,
            key: err.key,
            message: err.message,
            ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
        };
    }
    return { code: 500, key: 'INTERNAL_ERROR', message: 'internal error' };
}
//# sourceMappingURL=errors.js.map