/** Stable Application error contract consumed by transport error boundaries. */
export class AppError extends Error {
    status;
    key;
    retryable;
    constructor(status, key, message, retryable) {
        super(message);
        this.status = status;
        this.key = key;
        this.retryable = retryable;
        this.name = 'AppError';
    }
}
export class NotImplementedError extends AppError {
    constructor(method) {
        super(501, 'NOT_IMPLEMENTED', `${method} is not implemented in local-runtime-v2`);
    }
}
//# sourceMappingURL=errors.js.map