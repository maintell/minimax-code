import { ConnectorGatewayError } from '../../../host-connector-system/index.js';
export class HostConnectorProtocolError extends Error {
    name = 'HostConnectorProtocolError';
}
export class HostConnectorError extends Error {
    code;
    disposition;
    name = 'HostConnectorError';
    constructor(code, message, disposition, options) {
        super(message);
        this.code = code;
        this.disposition = disposition;
        this.retryable = options.retryable;
        this.invocationId = options.invocationId;
        if (options.diagnostic)
            this.diagnostic = options.diagnostic;
    }
    retryable;
    invocationId;
}
export class HostConnectorRequestTimeoutError extends Error {
    name = 'HostConnectorRequestTimeoutError';
}
export class HostConnectorCancelledError extends Error {
    name = 'HostConnectorCancelledError';
}
export function normalizeGatewayError(error, fallbackInvocationId, gatewayPromiseObtained = false) {
    if (error instanceof ConnectorGatewayError) {
        return normalizeTypedGatewayError(error, fallbackInvocationId);
    }
    if (error instanceof HostConnectorRequestTimeoutError) {
        return gatewayPromiseObtained && fallbackInvocationId
            ? unknownWireError(fallbackInvocationId, 'CONNECTOR_OUTCOME_UNKNOWN')
            : timeoutWireError(fallbackInvocationId);
    }
    if (error instanceof HostConnectorCancelledError) {
        return gatewayPromiseObtained && fallbackInvocationId
            ? unknownWireError(fallbackInvocationId, 'CONNECTOR_OUTCOME_UNKNOWN')
            : cancelledWireError(fallbackInvocationId);
    }
    return gatewayPromiseObtained && fallbackInvocationId
        ? unknownWireError(fallbackInvocationId, 'CONNECTOR_OUTCOME_UNKNOWN')
        : withInvocationId(unavailableWireError(fallbackInvocationId !== undefined), fallbackInvocationId);
}
export function unavailableWireError(retryable = false) {
    return {
        code: 'CONNECTOR_UNAVAILABLE',
        message: 'Host Connector calls are unavailable for this generation',
        disposition: 'not_dispatched',
        retryable,
    };
}
export function serviceRestartedWireError(invocationId) {
    return {
        code: 'SERVICE_RESTARTED',
        message: 'Mini App service restarted before Connector dispatch',
        disposition: 'not_dispatched',
        retryable: true,
        ...(invocationId ? { invocationId } : {}),
    };
}
export function staleToolWireError() {
    return {
        code: 'TOOL_REF_STALE',
        message: 'Host Connector tool reference is stale',
        disposition: 'not_dispatched',
        retryable: false,
    };
}
export function providerWireError(invocationId) {
    return {
        code: 'CONNECTOR_PROVIDER_ERROR',
        message: 'Connector provider reported an error',
        disposition: 'provider_reported',
        retryable: false,
        ...(invocationId ? { invocationId } : {}),
    };
}
function normalizeTypedGatewayError(error, fallbackInvocationId) {
    if (isInvalidArgumentsGatewayError(error)) {
        return invalidArgumentsWireError(error, fallbackInvocationId);
    }
    if (error.code === 'CONNECTOR_PRINCIPAL_CHANGED' && error.outcome === 'not_dispatched') {
        return withInvocationId(staleToolWireError(), fallbackInvocationId);
    }
    return normalizeOtherTypedGatewayError(error, fallbackInvocationId);
}
function normalizeOtherTypedGatewayError(error, fallbackInvocationId) {
    if (error.outcome === 'unknown_after_dispatch') {
        return unknownWireError(error.invocationId ?? fallbackInvocationId ?? 'unknown', 'CONNECTOR_OUTCOME_UNKNOWN');
    }
    if (error.outcome === 'provider_reported') {
        return providerWireError(error.invocationId ?? fallbackInvocationId);
    }
    if (error.code === 'REQUEST_ABORTED') {
        return withInvocationId({
            code: 'REQUEST_CANCELLED',
            message: 'Connector request was cancelled',
            disposition: 'not_dispatched',
            retryable: false,
        }, fallbackInvocationId);
    }
    return withInvocationId(unavailableWireError(error.code === 'CONNECTOR_AUDIT_UNAVAILABLE' || error.code === 'CONNECTOR_CALL_FAILED'), fallbackInvocationId);
}
function isInvalidArgumentsGatewayError(error) {
    return error.code === 'CONNECTOR_ARGUMENTS_INVALID' && error.outcome === 'not_dispatched';
}
function invalidArgumentsWireError(error, fallbackInvocationId) {
    const invocationId = error.invocationId ?? fallbackInvocationId;
    const diagnostic = projectGatewayDiagnostic(error);
    return {
        code: 'INVALID_ARGUMENTS',
        message: 'Connector arguments are invalid',
        disposition: 'not_dispatched',
        retryable: false,
        ...(invocationId ? { invocationId } : {}),
        ...(diagnostic ? { diagnostic } : {}),
    };
}
function projectGatewayDiagnostic(error) {
    const diagnostic = error.diagnostic;
    if (!isRecord(diagnostic) || !Array.isArray(diagnostic.issues))
        return undefined;
    const issues = [];
    for (const candidate of diagnostic.issues.slice(0, 4)) {
        const issue = projectDiagnosticIssue(candidate);
        if (issue)
            issues.push(issue);
    }
    return issues.length > 0 ? { issues } : undefined;
}
function projectDiagnosticIssue(value) {
    if (!isRecord(value) ||
        !isSafeHostConnectorDiagnosticPath(value.path) ||
        !isSafeHostConnectorDiagnosticConstraint(value.constraint)) {
        return undefined;
    }
    if ('limit' in value && (typeof value.limit !== 'number' || !Number.isFinite(value.limit))) {
        return undefined;
    }
    return {
        path: value.path,
        constraint: value.constraint,
        ...('limit' in value ? { limit: value.limit } : {}),
    };
}
export function isSafeHostConnectorDiagnosticPath(value) {
    if (!isBoundedJsonPointerString(value))
        return false;
    if (!hasSafeJsonPointerCharacters(value))
        return false;
    return hasOnlyUnicodeScalars(value);
}
function isBoundedJsonPointerString(value) {
    return (typeof value === 'string' &&
        Buffer.byteLength(value) <= 256 &&
        (value === '' || value.startsWith('/')));
}
function hasSafeJsonPointerCharacters(value) {
    return !/\p{Cc}/u.test(value) && !/~(?![01])/u.test(value);
}
function hasOnlyUnicodeScalars(value) {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff)
            return false;
    }
    return true;
}
export function isSafeHostConnectorDiagnosticConstraint(value) {
    return (typeof value === 'string' && Buffer.byteLength(value) <= 64 && /^[A-Za-z0-9_.~-]+$/u.test(value));
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function cancelledWireError(invocationId) {
    return {
        code: 'REQUEST_CANCELLED',
        message: 'Connector request was cancelled',
        disposition: 'not_dispatched',
        retryable: false,
        ...(invocationId ? { invocationId } : {}),
    };
}
function timeoutWireError(invocationId) {
    return {
        code: 'CONNECTOR_TIMEOUT',
        message: 'Host Connector request timed out',
        disposition: 'not_dispatched',
        retryable: true,
        ...(invocationId ? { invocationId } : {}),
    };
}
function unknownWireError(invocationId, code) {
    return {
        code,
        message: 'Connector outcome is unknown after dispatch',
        disposition: 'unknown_after_dispatch',
        retryable: false,
        invocationId,
    };
}
function withInvocationId(error, invocationId) {
    return invocationId ? { ...error, invocationId } : error;
}
//# sourceMappingURL=host-connector-errors.js.map