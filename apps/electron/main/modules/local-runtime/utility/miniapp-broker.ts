import { randomUUID } from "node:crypto";
import { isSafeBrokerRequestId } from "./control";
const MINIAPP_ERROR_MESSAGES = {
    invalid_request: 'Invalid Mini App request',
    runtime_unavailable: 'Mini App runtime is unavailable',
    not_found: 'Mini App was not found',
    busy: 'Mini App is busy',
    refresh_failed: 'Mini App page refresh failed',
    stop_failed: 'Mini App failed to stop',
    start_failed: 'Mini App failed to start',
};
const REQUEST_TIMEOUT_MS = 60000;
const REQUEST_SETTLEMENT_TIMEOUT_MS = 15000;
// Broker diagnostics cross a process boundary. Keep this closed to the
// Host-owned codes that distinguish manual activation/publication failures;
// unknown values stay private instead of being mirrored automatically.
const MINIAPP_BROKER_HOST_CODES = [
    'ACTIVATION_FAILED',
    'BUSY',
    'CANDIDATE_CHANGED',
    'CLEANUP_UNPROVEN',
    'CLOSED',
    'DISABLED',
    'MINIAPP_CATALOG_STALE',
    'MINIAPP_NOT_AVAILABLE',
    'MINIAPP_PREPARATION_FAILED',
    'NOT_FOUND',
    'NO_ACTIVE_GENERATION',
    'PERSISTENCE_COMPENSATION_FAILED',
    'PERSISTENCE_WRITE_FAILED',
    'PLUGIN_NOT_ENABLED',
    'PLUGIN_NOT_FOUND',
    'PUBLICATION_SUPERSEDED',
    'QUARANTINED',
    'RETIRED_GENERATION',
    'RUNTIME_EXITED',
    'RUNTIME_FAILED',
    'RUNTIME_START_FAILED',
    'RUNTIME_UNAVAILABLE',
    'SERVICE_RESTARTED',
    'SUPERSEDED',
];
const MINIAPP_BROKER_REASON_CODES = [
    'CANDIDATE_CHANGED',
    'ENTRY_OUTSIDE_ARTIFACT',
    'HOST_CONNECTOR_PROTOCOL_VIOLATION',
    'HOST_CONNECTOR_UNAVAILABLE',
    'MINIAPP_MCP_RUNTIME_NOT_READY',
    'MCP_SERVER_START_FAILED',
    'NO_CANDIDATE_PORT',
    'PUBLICATION_NOT_ACCEPTED',
    'PUBLICATION_SUPERSEDED',
    'READINESS_TIMEOUT',
    'RUNNER_LIFECYCLE_INVALID',
    'RUNNER_START_FAILED',
    'START_EXPORT_MISSING',
    'TCP_CONNECT_TIMEOUT',
];
const MINIAPP_BROKER_HOST_CODE_SET = new Set(MINIAPP_BROKER_HOST_CODES);
const MINIAPP_BROKER_REASON_CODE_SET = new Set(MINIAPP_BROKER_REASON_CODES);
const MINIAPP_STOP_ERROR_TYPES = [
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'ReferenceError',
    'URIError',
    'EvalError',
    'AggregateError',
    'AbortError',
    'MiniAppError',
    'MiniAppCleanupUnprovenError',
    'MiniAppNodeRuntimeError',
    'PluginSystemError',
    'unknown',
];
const MAX_STOP_FAILURE_DEPTH = 4;
const brokerFailureDiagnostics = new WeakMap();
export class MainMiniAppBrokerClient {
    constructor() {
        this.pending = new Map();
    }
    request(target, method, pluginId, signal) {
        if (signal?.aborted)
            return Promise.reject(abortError());
        const requestId = randomUUID();
        const message = {
            type: 'miniapp-request',
            requestId,
            method,
            ...(pluginId ? { pluginId } : {}),
        };
        if (!isMiniAppBrokerRequestMessage(message)) {
            return Promise.reject(miniAppError('invalid_request'));
        }
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.cancelRequest(requestId, target, 'deadline');
            }, REQUEST_TIMEOUT_MS);
            const pending = {
                target,
                method,
                resolve,
                reject,
                timeout,
                ...(signal ? { signal } : {}),
                requestPosted: false,
            };
            if (signal) {
                pending.abortListener = () => this.abortRequest(requestId, target);
                signal.addEventListener('abort', pending.abortListener, { once: true });
            }
            this.pending.set(requestId, pending);
            if (signal?.aborted) {
                this.abortRequest(requestId, target);
                return;
            }
            pending.requestPosted = true;
            try {
                target.postMessage(message);
            }
            catch {
                this.reject(requestId, target, miniAppError('runtime_unavailable'));
            }
        });
    }
    handleMessage(target, value) {
        if (!isRecord(value))
            return false;
        if (value.type !== 'miniapp-result' && value.type !== 'miniapp-error')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        const pending = this.take(requestId, target);
        if (!pending)
            return true;
        const diagnostic = parseBrokerErrorDiagnostic(readDataProperty(value, 'diagnostic'));
        if (isMiniAppBrokerResultMessage(value)) {
            pending.resolve(value.result);
        }
        else if (isMiniAppBrokerErrorMessage(value, diagnostic)) {
            if (pending.cancellation === 'caller') {
                pending.reject(abortError());
            }
            else {
                const error = miniAppError(value.code, value.busyReason);
                brokerFailureDiagnostics.set(error, Object.freeze({
                    brokerRequestId: value.requestId,
                    ...diagnostic,
                }));
                pending.reject(error);
            }
        }
        else {
            pending.reject(pending.cancellation === 'caller' ? abortError() : miniAppError('invalid_request'));
        }
        return true;
    }
    releaseTarget(target) {
        for (const [requestId, pending] of this.pending) {
            if (pending.target !== target)
                continue;
            this.reject(requestId, target, miniAppError('runtime_unavailable'));
        }
    }
    pendingCount() {
        return this.pending.size;
    }
    take(requestId, target) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.target !== target)
            return undefined;
        clearTimeout(pending.timeout);
        if (pending.settlementWatchdog)
            clearTimeout(pending.settlementWatchdog);
        if (pending.signal && pending.abortListener) {
            pending.signal.removeEventListener('abort', pending.abortListener);
        }
        this.pending.delete(requestId);
        return pending;
    }
    abortRequest(requestId, target) {
        const current = this.pending.get(requestId);
        if (!current || current.target !== target)
            return;
        if (current.method === 'stop' && current.requestPosted) {
            this.cancelRequest(requestId, target, 'caller');
            return;
        }
        const pending = this.take(requestId, target);
        if (!pending)
            return;
        if (pending.requestPosted)
            this.postCancel(target, requestId);
        pending.reject(abortError());
    }
    cancelRequest(requestId, target, cancellation) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.target !== target || pending.cancellation)
            return;
        const awaitAuthoritativeSettlement = pending.requestPosted &&
            (pending.method === 'stop' || (pending.method === 'open' && cancellation === 'deadline'));
        if (!awaitAuthoritativeSettlement) {
            const taken = this.take(requestId, target);
            if (!taken)
                return;
            if (taken.requestPosted)
                this.postCancel(target, requestId);
            taken.reject(cancellation === 'caller' ? abortError() : miniAppError('runtime_unavailable'));
            return;
        }
        pending.cancellation = cancellation;
        this.postCancel(target, requestId);
        if (this.pending.get(requestId) !== pending)
            return;
        pending.settlementWatchdog = setTimeout(() => {
            const unsettled = this.take(requestId, target);
            unsettled?.reject(cancellation === 'caller' ? abortError() : miniAppError('runtime_unavailable'));
        }, REQUEST_SETTLEMENT_TIMEOUT_MS);
        pending.settlementWatchdog.unref?.();
    }
    postCancel(target, requestId) {
        try {
            target.postMessage({
                type: 'miniapp-cancel',
                requestId,
            });
        }
        catch {
            // Target loss is settled by the watchdog or releaseTarget.
        }
    }
    reject(requestId, target, error) {
        const pending = this.take(requestId, target);
        pending?.reject(error);
    }
}

export class UtilityMiniAppBrokerServer {
    constructor(target) {
        this.target = target;
        this.pending = new Map();
    }
    bind(application) {
        this.application = application;
    }
    handleMessage(value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-cancel') {
            if (!isMiniAppBrokerCancelMessage(value))
                return true;
            this.cancelRequest(value.requestId);
            return true;
        }
        if (value.type !== 'miniapp-request')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        if (!isMiniAppBrokerRequestMessage(value)) {
            this.postError(requestId, 'invalid_request');
            return true;
        }
        if (this.pending.has(requestId)) {
            this.postError(requestId, 'busy');
            return true;
        }
        const application = this.application;
        if (!application) {
            this.postError(requestId, 'runtime_unavailable');
            return true;
        }
        const controller = new AbortController();
        const pending = { controller, method: value.method };
        this.pending.set(requestId, pending);
        void execute(application, value, controller.signal).then((result) => {
            if (!this.takePending(requestId, pending))
                return;
            if (!isMiniAppBrokerResult(result)) {
                this.postError(requestId, 'start_failed');
                return;
            }
            this.target.postMessage({ type: 'miniapp-result', requestId, result });
        }, (error) => {
            if (!this.takePending(requestId, pending))
                return;
            const code = normalizeErrorCode(error, value.method);
            this.postError(requestId, code, code === 'busy' ? normalizeBusyReason(error) : undefined, value.method === 'stop'
                ? readStopErrorDiagnostic(error)
                : value.method === 'open'
                    ? readBrokerErrorDiagnostic(error)
                    : undefined);
        });
        return true;
    }
    close() {
        this.application = undefined;
        for (const pending of this.pending.values()) {
            if (pending.settlementWatchdog)
                clearTimeout(pending.settlementWatchdog);
            pending.controller.abort();
        }
        this.pending.clear();
    }
    pendingCount() {
        return this.pending.size;
    }
    cancelRequest(requestId) {
        const pending = this.pending.get(requestId);
        if (!pending || pending.controller.signal.aborted)
            return;
        if (pending.method !== 'open' && pending.method !== 'stop') {
            this.pending.delete(requestId);
            pending.controller.abort();
            return;
        }
        pending.settlementWatchdog = setTimeout(() => {
            if (!this.takePending(requestId, pending))
                return;
            this.postError(requestId, 'runtime_unavailable');
        }, REQUEST_SETTLEMENT_TIMEOUT_MS);
        pending.settlementWatchdog.unref?.();
        // Keep open/stop registered until the operation reports whether a native
        // tab was committed or a direct root was actually stopped. The watchdog
        // is only cleanup; it never invents either success result.
        pending.controller.abort();
    }
    takePending(requestId, expected) {
        const pending = this.pending.get(requestId);
        if (pending !== expected)
            return false;
        this.pending.delete(requestId);
        if (pending.settlementWatchdog)
            clearTimeout(pending.settlementWatchdog);
        return true;
    }
    postError(requestId, code, busyReason, diagnostic) {
        this.target.postMessage({
            type: 'miniapp-error',
            requestId,
            code,
            message: MINIAPP_ERROR_MESSAGES[code],
            ...(code === 'busy' && busyReason ? { busyReason } : {}),
            ...(diagnostic ? { diagnostic } : {}),
        });
    }
}

/** Reads only the private, bounded diagnostic attached by the Main-side broker client. */
export function readMiniAppBrokerFailureDiagnostic(error) {
    return error instanceof Error ? brokerFailureDiagnostics.get(error) : undefined;
}
async function execute(application, request, signal) {
    if (request.method === 'list')
        return application.list();
    const pluginId = request.pluginId;
    if (!pluginId)
        throw miniAppError('invalid_request');
    if (request.method === 'open')
        return application.open({ pluginId, signal });
    await application.stop({ pluginId, signal });
    return { stopped: true };
}
function normalizeErrorCode(error, method) {
    if (error instanceof Error && error.name === 'AbortError') {
        return 'runtime_unavailable';
    }
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code === 'NOT_FOUND' || code === 'PLUGIN_NOT_FOUND' || code === 'PLUGIN_NOT_ENABLED') {
        return 'not_found';
    }
    if (code === 'BUSY' || code === 'PUBLICATION_SUPERSEDED')
        return 'busy';
    if (code === 'RUNTIME_UNAVAILABLE')
        return 'runtime_unavailable';
    if (code === 'INVALID_REQUEST')
        return 'invalid_request';
    return method === 'stop' ? 'stop_failed' : 'start_failed';
}
function normalizeBusyReason(error) {
    const busyReason = error && typeof error === 'object' && 'busyReason' in error
        ? error.busyReason
        : undefined;
    return busyReason === 'capacity_busy' || busyReason === 'operation_busy' ? busyReason : undefined;
}
function miniAppError(code, busyReason) {
    return Object.assign(new Error(MINIAPP_ERROR_MESSAGES[code]), {
        code,
        ...(code === 'busy' && busyReason ? { busyReason } : {}),
    });
}
function abortError() {
    return Object.assign(new Error('Mini App request was cancelled'), { name: 'AbortError' });
}
function readBrokerErrorDiagnostic(error, dataOnly = false) {
    const fields = dataOnly
        ? {
            code: readDataProperty(error, 'code', true),
            reasonCode: readDataProperty(error, 'reasonCode', true),
        }
        : error;
    const hostCode = readAllowedErrorToken(fields, 'code', MINIAPP_BROKER_HOST_CODE_SET);
    const reasonCode = readAllowedErrorToken(fields, 'reasonCode', MINIAPP_BROKER_REASON_CODE_SET);
    return hostCode || reasonCode
        ? {
            ...(hostCode ? { hostCode: hostCode } : {}),
            ...(reasonCode ? { reasonCode: reasonCode } : {}),
        }
        : undefined;
}
function readAllowedErrorToken(error, key, allowed) {
    if (!isRecord(error))
        return undefined;
    try {
        const value = error[key];
        return typeof value === 'string' && allowed.has(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/** Diagnostics read data properties only; getters must not run during failure reporting. */
function readDataProperty(value, key, inherited = false) {
    try {
        let current = value;
        for (let depth = 0; depth < MAX_STOP_FAILURE_DEPTH; depth += 1) {
            if (!current || typeof current !== 'object')
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (descriptor)
                return 'value' in descriptor ? descriptor.value : undefined;
            if (!inherited)
                return undefined;
            current = Object.getPrototypeOf(current);
        }
    }
    catch {
        // Hostile properties cannot replace the original operation result.
    }
    return undefined;
}
function readStopErrorDiagnostic(error) {
    const failureChain = [];
    const seen = new Set();
    let current = error;
    while (failureChain.length < MAX_STOP_FAILURE_DEPTH && !seen.has(current)) {
        seen.add(current);
        const name = readDataProperty(current, 'name', true);
        const errorType = MINIAPP_STOP_ERROR_TYPES.find((type) => type === name) ?? 'unknown';
        failureChain.push({
            errorType,
            ...readBrokerErrorDiagnostic(current, true),
        });
        const cause = readDataProperty(current, 'cause');
        if (cause === undefined)
            break;
        current = cause;
    }
    return { ...readBrokerErrorDiagnostic(error, true), failureChain };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function isSafePluginId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isMiniAppBrokerRequestMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp-request')
        return false;
    if (!hasOnlyKeys(value, ['type', 'requestId', 'method', 'pluginId']))
        return false;
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (value.method !== 'list' && value.method !== 'open' && value.method !== 'stop') {
        return false;
    }
    return value.method === 'list' ? value.pluginId === undefined : isSafePluginId(value.pluginId);
}
function isMiniAppBrokerCancelMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-cancel' &&
        hasOnlyKeys(value, ['type', 'requestId']) &&
        isSafeBrokerRequestId(value.requestId));
}
function isMiniAppSurfaceSummary(value) {
    if (!isRecord(value))
        return false;
    if (!hasOnlyKeys(value, ['pluginId', 'displayName', 'description', 'iconUrl', 'runtime'])) {
        return false;
    }
    if (!isSafePluginId(value.pluginId))
        return false;
    if ((value.displayName !== undefined && !isSafeLabel(value.displayName)) ||
        (value.description !== undefined && !isSafeDescription(value.description)) ||
        (value.iconUrl !== undefined && !isSafeIconUrl(value.iconUrl))) {
        return false;
    }
    if (!isRecord(value.runtime))
        return false;
    if (!hasOnlyKeys(value.runtime, ['kind', 'status', 'errorCode']))
        return false;
    if (value.runtime.kind !== 'process')
        return false;
    if (value.runtime.status !== 'stopped' &&
        value.runtime.status !== 'starting' &&
        value.runtime.status !== 'running' &&
        value.runtime.status !== 'stopping' &&
        value.runtime.status !== 'failed') {
        return false;
    }
    return value.runtime.errorCode === undefined || isSafeLabel(value.runtime.errorCode);
}
function isSafeLabel(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isSafeDescription(value) {
    return (typeof value === 'string' &&
        value.length <= 2048 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
}
function isSafeIconUrl(value) {
    return (typeof value === 'string' &&
        value.length <= 4096 &&
        value.startsWith('/mavis/api/file/preview?path=') &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isSafeLoopbackOrigin(value) {
    if (typeof value !== 'string' || value.length > 128)
        return false;
    try {
        const parsed = new URL(value);
        return (parsed.protocol === 'http:' &&
            (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') &&
            Boolean(parsed.port) &&
            parsed.origin === value);
    }
    catch {
        return false;
    }
}
function isSafeSurfacePath(value) {
    return (typeof value === 'string' &&
        value.startsWith('/') &&
        !value.startsWith('//') &&
        value.length <= 2048 &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isMiniAppBrokerResult(value) {
    if (!isRecord(value))
        return false;
    if ('stopped' in value)
        return hasOnlyKeys(value, ['stopped']) && value.stopped === true;
    if ('miniApps' in value) {
        return (hasOnlyKeys(value, ['miniApps']) &&
            Array.isArray(value.miniApps) &&
            value.miniApps.length <= 256 &&
            value.miniApps.every(isMiniAppSurfaceSummary));
    }
    return (hasOnlyKeys(value, ['miniApp', 'launch']) &&
        isMiniAppSurfaceSummary(value.miniApp) &&
        isRecord(value.launch) &&
        hasOnlyKeys(value.launch, ['origin', 'surfacePath', 'runId']) &&
        isSafeLoopbackOrigin(value.launch.origin) &&
        isSafeSurfacePath(value.launch.surfacePath) &&
        isSafeLabel(value.launch.runId));
}
function isMiniAppBrokerResultMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-result' &&
        hasOnlyKeys(value, ['type', 'requestId', 'result']) &&
        isSafeBrokerRequestId(value.requestId) &&
        isMiniAppBrokerResult(value.result));
}
function isMiniAppBrokerErrorMessage(value, diagnostic) {
    if (!isRecord(value) || value.type !== 'miniapp-error')
        return false;
    if (!hasOnlyKeys(value, ['type', 'requestId', 'code', 'message', 'busyReason', 'diagnostic'])) {
        return false;
    }
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (value.code !== 'invalid_request' &&
        value.code !== 'runtime_unavailable' &&
        value.code !== 'not_found' &&
        value.code !== 'busy' &&
        value.code !== 'refresh_failed' &&
        value.code !== 'stop_failed' &&
        value.code !== 'start_failed') {
        return false;
    }
    if (value.message !== MINIAPP_ERROR_MESSAGES[value.code])
        return false;
    if (Object.prototype.hasOwnProperty.call(value, 'busyReason') &&
        !(value.code === 'busy' &&
            (value.busyReason === 'capacity_busy' || value.busyReason === 'operation_busy'))) {
        return false;
    }
    return !Object.prototype.hasOwnProperty.call(value, 'diagnostic') || diagnostic !== undefined;
}
function parseBrokerErrorDiagnostic(value) {
    const fields = readDataRecord(value, ['hostCode', 'reasonCode', 'failureChain']);
    if (!fields || Object.keys(fields).length === 0 || !hasValidFailureCodes(fields))
        return undefined;
    const failureChain = [];
    if ('failureChain' in fields) {
        const entries = readDataRecord(fields.failureChain, ['length', '0', '1', '2', '3']);
        if (!entries ||
            !Array.isArray(fields.failureChain) ||
            !Number.isInteger(entries.length) ||
            Number(entries.length) < 1 ||
            Number(entries.length) > MAX_STOP_FAILURE_DEPTH)
            return undefined;
        for (let index = 0; index < Number(entries.length); index += 1) {
            const entry = parseStopFailureFrame(entries[String(index)]);
            if (!entry)
                return undefined;
            failureChain.push(entry);
        }
    }
    return Object.freeze({
        ...(fields.hostCode ? { hostCode: fields.hostCode } : {}),
        ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
        ...(failureChain.length ? { failureChain: Object.freeze(failureChain) } : {}),
    });
}
function parseStopFailureFrame(value) {
    const fields = readDataRecord(value, ['errorType', 'hostCode', 'reasonCode']);
    if (!fields || !hasValidFailureCodes(fields))
        return undefined;
    const errorType = MINIAPP_STOP_ERROR_TYPES.find((type) => type === fields.errorType);
    if (!errorType)
        return undefined;
    return Object.freeze({
        errorType,
        ...(fields.hostCode ? { hostCode: fields.hostCode } : {}),
        ...(fields.reasonCode ? { reasonCode: fields.reasonCode } : {}),
    });
}
function hasValidFailureCodes(fields) {
    return ((!('hostCode' in fields) ||
        (typeof fields.hostCode === 'string' && MINIAPP_BROKER_HOST_CODE_SET.has(fields.hostCode))) &&
        (!('reasonCode' in fields) ||
            (typeof fields.reasonCode === 'string' &&
                MINIAPP_BROKER_REASON_CODE_SET.has(fields.reasonCode))));
}
function readDataRecord(value, allowed) {
    try {
        if (!value || typeof value !== 'object')
            return undefined;
        const fields = Object.create(null);
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string' || !allowed.includes(key))
                return undefined;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !('value' in descriptor))
                return undefined;
            fields[key] = descriptor.value;
        }
        return fields;
    }
    catch {
        return undefined;
    }
}
