export const AUTH_LEASE_PROTOCOL_PACKAGE_NAME = '@mavis/oauth-lease-protocol';
export const AUTH_LEASE_PROTOCOL_PACKAGE_VERSION = '0.1.0-beta.0';
export const AUTH_LEASE_PROTOCOL_VERSION = 1;
export const AUTH_LEASE_AUDIENCE = 'agent-backend';
export const AUTH_LEASE_SCOPES = ['agent.default'];
export const AUTH_LEASE_MAX_FRAME_BYTES = 64 * 1024;
export const AUTH_LEASE_MAX_MIN_VALIDITY_MS = 5 * 60 * 1000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ACCESS_TOKEN_LENGTH = 32 * 1024;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/u;
const ERROR_MESSAGES = Object.freeze({
    AUTH_REQUIRED: 'Desktop authentication is required.',
    BROKER_UNAVAILABLE: 'Desktop authentication integration is unavailable.',
    CAPABILITY_REJECTED: 'Desktop authentication capability was rejected.',
    PROTOCOL_MISMATCH: 'Desktop authentication protocol is incompatible.',
    INVALID_REQUEST: 'Desktop authentication request is invalid.',
    INTERNAL_ERROR: 'Desktop authentication request failed.',
});
export class AuthLeaseProtocolError extends Error {
    code;
    constructor(code) {
        super(ERROR_MESSAGES[code]);
        this.name = 'AuthLeaseProtocolError';
        this.code = code;
    }
}
export function authLeaseErrorMessage(code) {
    return ERROR_MESSAGES[code];
}
export function parseAuthLeaseRequest(value) {
    const record = requireRecord(value);
    if (record.version !== AUTH_LEASE_PROTOCOL_VERSION) {
        throw new AuthLeaseProtocolError('PROTOCOL_MISMATCH');
    }
    const requestId = requireRequestId(record.requestId);
    const capability = requireCapability(record.capability);
    if (record.method === 'status') {
        requireExactKeys(record, ['version', 'requestId', 'capability', 'method']);
        return { version: 1, requestId, capability, method: 'status' };
    }
    if (record.method === 'lease') {
        requireExactKeys(record, ['version', 'requestId', 'capability', 'method', 'minValidityMs']);
        const minValidityMs = requireBoundedInteger(record.minValidityMs, 0, AUTH_LEASE_MAX_MIN_VALIDITY_MS);
        return { version: 1, requestId, capability, method: 'lease', minValidityMs };
    }
    if (record.method === 'unauthorized') {
        requireExactKeys(record, ['version', 'requestId', 'capability', 'method', 'generation']);
        const generation = requireBoundedInteger(record.generation, 0, Number.MAX_SAFE_INTEGER);
        return { version: 1, requestId, capability, method: 'unauthorized', generation };
    }
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
}
export function parseAuthLeaseResponse(value) {
    const record = requireRecord(value);
    if (record.version !== AUTH_LEASE_PROTOCOL_VERSION) {
        throw new AuthLeaseProtocolError('PROTOCOL_MISMATCH');
    }
    const requestId = requireRequestId(record.requestId);
    if (record.ok === true) {
        requireExactKeys(record, ['version', 'requestId', 'ok', 'result']);
        return {
            version: 1,
            requestId,
            ok: true,
            result: parseSuccessResult(record.result),
        };
    }
    if (record.ok === false) {
        requireExactKeys(record, ['version', 'requestId', 'ok', 'error']);
        const error = requireRecord(record.error);
        requireExactKeys(error, ['code', 'message']);
        const code = requireErrorCode(error.code);
        if (error.message !== ERROR_MESSAGES[code]) {
            throw new AuthLeaseProtocolError('INVALID_REQUEST');
        }
        return { version: 1, requestId, ok: false, error: { code, message: ERROR_MESSAGES[code] } };
    }
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
}
export function createAuthLeaseFailureResponse(requestId, error) {
    const safeRequestId = requireRequestId(requestId);
    const code = error instanceof AuthLeaseProtocolError ? error.code : 'INTERNAL_ERROR';
    return {
        version: AUTH_LEASE_PROTOCOL_VERSION,
        requestId: safeRequestId,
        ok: false,
        error: { code, message: ERROR_MESSAGES[code] },
    };
}
export function createAuthLeaseSuccessResponse(requestId, result) {
    return parseAuthLeaseResponse({
        version: AUTH_LEASE_PROTOCOL_VERSION,
        requestId,
        ok: true,
        result,
    });
}
function parseSuccessResult(value) {
    const result = requireRecord(value);
    if (result.method === 'status')
        return parseStatusResult(result);
    if (result.method === 'lease')
        return parseLeaseResult(result);
    if (result.method === 'unauthorized')
        return parseUnauthorizedResult(result);
    throw new AuthLeaseProtocolError('INVALID_REQUEST');
}
function parseStatusResult(result) {
    const allowedKeys = ['method', 'status', 'generation'];
    if (result.expiresAtMs !== undefined)
        allowedKeys.push('expiresAtMs');
    requireExactKeys(result, allowedKeys);
    const statuses = [
        'anonymous',
        'authorizing',
        'authenticated',
        'refreshing',
        'scope_upgrade_required',
        'logging_out',
        'logout_pending',
        'expired',
        'error',
    ];
    if (!statuses.includes(result.status)) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    const status = result.status;
    const generation = requireBoundedInteger(result.generation, 0, Number.MAX_SAFE_INTEGER);
    if (result.expiresAtMs === undefined)
        return { method: 'status', status, generation };
    return {
        method: 'status',
        status,
        generation,
        expiresAtMs: requireBoundedInteger(result.expiresAtMs, 0, Number.MAX_SAFE_INTEGER),
    };
}
function parseLeaseResult(result) {
    requireExactKeys(result, [
        'method',
        'accessToken',
        'expiresAtMs',
        'generation',
        'audience',
        'scopes',
    ]);
    if (typeof result.accessToken !== 'string' ||
        result.accessToken.length === 0 ||
        result.accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
        result.audience !== AUTH_LEASE_AUDIENCE ||
        !Array.isArray(result.scopes) ||
        result.scopes.length !== 1 ||
        result.scopes[0] !== AUTH_LEASE_SCOPES[0]) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return {
        method: 'lease',
        accessToken: result.accessToken,
        expiresAtMs: requireBoundedInteger(result.expiresAtMs, 0, Number.MAX_SAFE_INTEGER),
        generation: requireBoundedInteger(result.generation, 0, Number.MAX_SAFE_INTEGER),
        audience: AUTH_LEASE_AUDIENCE,
        scopes: AUTH_LEASE_SCOPES,
    };
}
function parseUnauthorizedResult(result) {
    requireExactKeys(result, ['method', 'action']);
    if (result.action !== 'retry' && result.action !== 'logout') {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return { method: 'unauthorized', action: result.action };
}
function requireRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return value;
}
function requireExactKeys(record, allowed) {
    const allowedKeys = new Set(allowed);
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
}
function requireRequestId(value) {
    if (typeof value !== 'string' ||
        value.length === 0 ||
        value.length > MAX_REQUEST_ID_LENGTH ||
        !REQUEST_ID_PATTERN.test(value)) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return value;
}
function requireCapability(value) {
    if (typeof value !== 'string' || !CAPABILITY_PATTERN.test(value)) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return value;
}
function requireBoundedInteger(value, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return value;
}
function requireErrorCode(value) {
    if (typeof value !== 'string' || !(value in ERROR_MESSAGES)) {
        throw new AuthLeaseProtocolError('INVALID_REQUEST');
    }
    return value;
}
//# sourceMappingURL=contracts.js.map