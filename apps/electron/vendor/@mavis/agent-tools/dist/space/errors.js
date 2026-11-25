/** Stable error contract of the space_* tools; the Space skill documents these codes. */
/** `base_resp.status_code` values the Space tools distinguish. */
export const DRIVE_STATUS = {
    /** GET file by id answers this for a node that is gone. */
    INVALID_PARAMS: 1406010011,
    STORAGE_IS_FULL: 1400010361,
    NODE_NOT_FOUND: 1406010111,
    NAME_CONFLICT: 1406010281,
    FILE_TOO_LARGE: 1406010291,
    OPERATION_NOT_ALLOWED: 1406010301,
    UPLOAD_NOT_READY: 1406010311,
    DEPTH_EXCEEDED: 1406010321,
    /** Upload content or a link rename failed the content review. */
    CONTENT_VIOLATION: 1406010081,
};
export class SpaceError extends Error {
    code;
    retryable;
    statusCode;
    constructor(code, message, retryable = false, 
    /** Drive business status when the failure came from one. */
    statusCode) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.statusCode = statusCode;
        this.name = 'SpaceError';
    }
}
const BUSINESS_CODES = {
    [DRIVE_STATUS.NODE_NOT_FOUND]: 'NOT_FOUND',
    [DRIVE_STATUS.NAME_CONFLICT]: 'NAME_CONFLICT',
    [DRIVE_STATUS.FILE_TOO_LARGE]: 'TOO_LARGE',
    [DRIVE_STATUS.OPERATION_NOT_ALLOWED]: 'NOT_ALLOWED',
    [DRIVE_STATUS.UPLOAD_NOT_READY]: 'UPSTREAM',
    [DRIVE_STATUS.STORAGE_IS_FULL]: 'QUOTA_EXCEEDED',
    [DRIVE_STATUS.INVALID_PARAMS]: 'INVALID_ARGS',
    [DRIVE_STATUS.DEPTH_EXCEEDED]: 'DEPTH_EXCEEDED',
    [DRIVE_STATUS.CONTENT_VIOLATION]: 'CONTENT_VIOLATION',
};
export function spaceErrorFromBusinessStatus(statusCode, message) {
    return new SpaceError(BUSINESS_CODES[statusCode] ?? 'UPSTREAM', sanitizeMessage(message), statusCode === DRIVE_STATUS.UPLOAD_NOT_READY, statusCode);
}
export function spaceErrorFromHttpStatus(status, message) {
    const safe = sanitizeMessage(message);
    if (status === 401)
        return new SpaceError('UNAUTHORIZED', safe);
    if (status === 403)
        return new SpaceError('FORBIDDEN', safe);
    if (status === 429)
        return new SpaceError('RATE_LIMITED', safe, true);
    if (status >= 500)
        return new SpaceError('UPSTREAM', safe, true);
    if (status === 400)
        return new SpaceError('INVALID_ARGS', safe);
    if (status === 413)
        return new SpaceError('TOO_LARGE', safe);
    return new SpaceError('UPSTREAM', safe);
}
/** Map any failure to the stable contract. Unknown failures are UPSTREAM. */
export function toSpaceError(error) {
    if (error instanceof SpaceError) {
        return new SpaceError(error.code, sanitizeMessage(error.message), error.retryable, error.statusCode);
    }
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error));
    if (isLocalFileSystemError(error))
        return new SpaceError('INVALID_ARGS', message);
    return new SpaceError('UPSTREAM', message, isTransientFailure(error));
}
/** Pre-signed URLs, bearer tokens and OAuth token-shaped strings never reach the model. */
export function sanitizeMessage(message) {
    return message
        .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => {
        try {
            const parsed = new URL(url);
            return `${parsed.origin}${parsed.pathname}`;
        }
        catch {
            return url.replace(/[?#].*$/u, '');
        }
    })
        .replace(/\bBearer\s+[^\s"',;]+/giu, 'Bearer <redacted>')
        .replace(/\bmm[a-z]{1,4}_[A-Za-z0-9._~+/=-]+/gu, '<redacted>');
}
function isLocalFileSystemError(error) {
    if (!(error instanceof Error))
        return false;
    const errno = error;
    return typeof errno.syscall === 'string' && typeof errno.path === 'string';
}
function isTransientFailure(error) {
    return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
}
//# sourceMappingURL=errors.js.map