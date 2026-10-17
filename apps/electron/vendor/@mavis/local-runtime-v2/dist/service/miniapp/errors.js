const MINIAPP_RUNTIME_FAILURE_REASON_CODES = new Set([
    'ENTRY_OUTSIDE_ARTIFACT',
    'HOST_CONNECTOR_PROTOCOL_VIOLATION',
    'HOST_CONNECTOR_UNAVAILABLE',
    'NO_CANDIDATE_PORT',
    'READINESS_TIMEOUT',
    'RUNNER_LIFECYCLE_INVALID',
    'RUNNER_START_FAILED',
    'START_EXPORT_MISSING',
    'TCP_CONNECT_TIMEOUT',
]);
export const MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES = 64 * 1024;
const runtimeErrorDetails = new WeakMap();
const provenRootTerminationErrors = new WeakSet();
/** Keeps both the exception summary and the deepest stack frames within one IPC field budget. */
export function boundMiniAppRuntimeErrorText(text, label) {
    const originalBytes = Buffer.byteLength(text, 'utf8');
    if (originalBytes <= MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES)
        return text;
    const noticeLabel = boundedNoticeLabel(label);
    const notice = `\n[... ${noticeLabel} truncated from ${originalBytes} bytes ...]\n`;
    const contentBudget = MINIAPP_RUNTIME_ERROR_TEXT_MAX_BYTES - Buffer.byteLength(notice, 'utf8');
    const headBudget = Math.ceil(contentBudget / 2);
    const tailBudget = contentBudget - headBudget;
    return `${utf8Prefix(text, headBudget)}${notice}${utf8Suffix(text, tailBudget)}`;
}
export class MiniAppError extends Error {
    code;
    name = 'MiniAppError';
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        const reasonCode = options?.reasonCode ?? (code === 'CANDIDATE_CHANGED' ? 'CANDIDATE_CHANGED' : undefined);
        if (reasonCode)
            this.reasonCode = reasonCode;
        const busyReason = options?.busyReason ?? miniAppBusyReason(options?.cause);
        if (code === 'BUSY' && busyReason)
            this.busyReason = busyReason;
        if (options?.runtimeError)
            this.runtimeError = freezeRuntimeErrorDetail(options.runtimeError);
    }
}
export class MiniAppCleanupUnprovenError extends MiniAppError {
    name = 'MiniAppCleanupUnprovenError';
    constructor(message, options) {
        super('CLEANUP_UNPROVEN', message, options);
    }
}
export function isMiniAppCleanupUnproven(error) {
    return error instanceof MiniAppCleanupUnprovenError;
}
export function miniAppFailureReasonCode(error) {
    return error instanceof MiniAppError ? error.reasonCode : undefined;
}
export function miniAppErrorCode(error) {
    const code = readProperty(error, 'code');
    if (typeof code === 'string')
        return code;
    return 'RUNTIME_START_FAILED';
}
export function isMiniAppExpectedCancellation(code) {
    return code === 'CLOSED' || code === 'DISABLED' || code === 'SUPERSEDED';
}
/** Attaches Host-owned diagnostics without trusting fields found on arbitrary error objects. */
export function attachMiniAppRuntimeErrorDetail(error, detail) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function'))
        return;
    runtimeErrorDetails.set(error, freezeRuntimeErrorDetail(detail));
}
/** Reads diagnostics attached directly to this exact error identity. */
export function readMiniAppRuntimeErrorDetail(error) {
    if (error instanceof MiniAppError && error.runtimeError)
        return error.runtimeError;
    if (!error || (typeof error !== 'object' && typeof error !== 'function'))
        return undefined;
    return runtimeErrorDetails.get(error);
}
/** Records Host-owned proof without mutating or replacing the original post-stop error. */
export function markMiniAppRootTerminationProven(error) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function'))
        return;
    provenRootTerminationErrors.add(error);
}
/** Reads proof attached directly to this exact post-stop error identity. */
export function isMiniAppRootTerminationProven(error) {
    if (!error || (typeof error !== 'object' && typeof error !== 'function'))
        return false;
    return provenRootTerminationErrors.has(error);
}
export function normalizeMiniAppRuntimeError(error, message) {
    if (error instanceof MiniAppError)
        return error;
    const code = miniAppErrorCode(error);
    const reasonCode = runtimeFailureReasonCode(error);
    const busyReason = miniAppBusyReason(error);
    const runtimeError = readMiniAppRuntimeErrorDetail(error);
    return new MiniAppError(code === 'BUSY' ? 'BUSY' : 'RUNTIME_START_FAILED', message, {
        cause: error,
        ...(reasonCode ? { reasonCode } : {}),
        ...(code === 'BUSY' && busyReason ? { busyReason } : {}),
        ...(runtimeError ? { runtimeError } : {}),
    });
}
/** Returns only explicit, bounded BUSY metadata; private messages and class names are ignored. */
export function miniAppBusyReason(error) {
    const visited = new Set();
    let current = error;
    for (let depth = 0; depth < 8 && isRecord(current) && !visited.has(current); depth += 1) {
        visited.add(current);
        const busyReason = readProperty(current, 'busyReason');
        if (busyReason === 'operation_busy' || busyReason === 'capacity_busy') {
            return busyReason;
        }
        current = readProperty(current, 'cause');
    }
    return undefined;
}
export function cancellationOrSupersededError(signal, message) {
    return signal.reason instanceof Error ? signal.reason : new MiniAppError('SUPERSEDED', message);
}
export function assertMiniAppCleanupsProven(results) {
    const failure = results.find((result) => result.status === 'rejected' && isMiniAppCleanupUnproven(result.reason));
    if (!failure)
        return;
    throw failure.reason;
}
function runtimeFailureReasonCode(error) {
    const code = readProperty(error, 'code');
    return typeof code === 'string' && MINIAPP_RUNTIME_FAILURE_REASON_CODES.has(code)
        ? code
        : undefined;
}
function isRecord(value) {
    try {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }
    catch {
        return false;
    }
}
function readProperty(value, key) {
    if (!isRecord(value))
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
function freezeRuntimeErrorDetail(detail) {
    return Object.freeze({
        errorText: boundMiniAppRuntimeErrorText(detail.errorText, 'runtime error text'),
        ...(detail.stderr !== undefined
            ? { stderr: boundMiniAppRuntimeErrorText(detail.stderr, 'runtime stderr') }
            : {}),
    });
}
function boundedNoticeLabel(label) {
    if (!label || label.length > 128)
        return 'runtime error text';
    const singleLine = label.replace(/[\r\n]+/gu, ' ').trim();
    return Buffer.byteLength(singleLine, 'utf8') <= 128 && singleLine.length > 0
        ? singleLine
        : 'runtime error text';
}
function utf8Prefix(value, maxBytes) {
    let end = 0;
    let bytes = 0;
    while (end < value.length) {
        const codePoint = value.codePointAt(end);
        const codeUnits = codePoint > 0xffff ? 2 : 1;
        const nextBytes = utf8CodePointBytes(codePoint);
        if (bytes + nextBytes > maxBytes)
            break;
        bytes += nextBytes;
        end += codeUnits;
    }
    return value.slice(0, end);
}
function utf8Suffix(value, maxBytes) {
    let start = value.length;
    let bytes = 0;
    while (start > 0) {
        let nextStart = start - 1;
        const lastCodeUnit = value.charCodeAt(nextStart);
        if (lastCodeUnit >= 0xdc00 &&
            lastCodeUnit <= 0xdfff &&
            nextStart > 0 &&
            value.charCodeAt(nextStart - 1) >= 0xd800 &&
            value.charCodeAt(nextStart - 1) <= 0xdbff) {
            nextStart -= 1;
        }
        const nextBytes = utf8CodePointBytes(value.codePointAt(nextStart));
        if (bytes + nextBytes > maxBytes)
            break;
        bytes += nextBytes;
        start = nextStart;
    }
    return value.slice(start);
}
function utf8CodePointBytes(codePoint) {
    if (codePoint <= 0x7f)
        return 1;
    if (codePoint <= 0x7ff)
        return 2;
    if (codePoint <= 0xffff)
        return 3;
    return 4;
}
//# sourceMappingURL=errors.js.map