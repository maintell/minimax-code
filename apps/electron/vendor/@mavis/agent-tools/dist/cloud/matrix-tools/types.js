const MATRIX_AUTH_REQUIRED_REASONS = ['managed_login', 'matrix_token'];
/** Reads the backend a gateway HTTP error was raised for, when it carries one. */
export function readMatrixGatewayBackend(err) {
    if (!(err instanceof Error))
        return undefined;
    const backend = err.backend;
    return backend === 'managed' || backend === 'custom' ? backend : undefined;
}
/**
 * Thrown before any request when a Matrix client has no credential to send, so
 * callers can tell the user to sign in instead of reporting a request failure.
 */
export class MatrixAuthRequiredError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.reason = reason;
        this.name = 'MatrixAuthRequiredError';
    }
}
/**
 * Reads the reason of a {@link MatrixAuthRequiredError}, also from a copy of
 * the class bundled separately (matched by name and a known reason).
 */
export function readMatrixAuthRequiredReason(err) {
    if (err instanceof MatrixAuthRequiredError)
        return err.reason;
    if (!(err instanceof Error) || err.name !== 'MatrixAuthRequiredError')
        return undefined;
    const reason = err.reason;
    return typeof reason === 'string' && MATRIX_AUTH_REQUIRED_REASONS.includes(reason)
        ? reason
        : undefined;
}
export class MatrixMediaError extends Error {
    kind;
    underlying;
    constructor(kind, message, underlying) {
        super(message);
        this.kind = kind;
        this.name = 'MatrixMediaError';
        if (underlying !== undefined)
            this.underlying = underlying;
    }
}
export function readMatrixMediaErrorKind(err) {
    if (err instanceof MatrixMediaError)
        return err.kind;
    if (err && typeof err === 'object') {
        const kind = err.kind;
        return typeof kind === 'string' ? kind : undefined;
    }
    return undefined;
}
//# sourceMappingURL=types.js.map