import { randomUUID } from "node:crypto";
import { isMiniAppSleepReason } from "@mavis/shared/miniapp-surface";
import { isSafeBrokerRequestId } from "./control";
const SURFACE_ERROR_MESSAGES = {
    invalid_request: 'Invalid Mini App request',
    runtime_unavailable: 'Mini App runtime is unavailable',
    not_found: 'Mini App was not found',
    busy: 'Mini App is busy',
    start_failed: 'Mini App failed to start',
};
const SURFACE_CLOSE_ERROR_MESSAGES = {
    invalid_request: 'Invalid Mini App close request',
    runtime_unavailable: 'Mini App runtime is unavailable',
    close_failed: 'Mini App surface cleanup failed',
};
const SURFACE_SLEEP_ERROR_MESSAGES = {
    invalid_request: 'Invalid Mini App sleep request',
    runtime_unavailable: 'Mini App runtime is unavailable',
    sleep_failed: 'Mini App page could not be put to sleep',
};
const SURFACE_SLEEP_REFUSALS = [
    'visible',
    'loading',
    'busy',
    'not_found',
];
// The surface request serially includes a 60s runtime launch and up to a 60s
// background-render queue plus a 60s tab operation. Keep the outer deadline
// above every valid inner phase with the same cleanup margin as Browser IPC.
const SURFACE_REQUEST_TIMEOUT_MS = 275000;
const SURFACE_SETTLEMENT_TIMEOUT_MS = 15000;
const SURFACE_CLOSE_REQUEST_TIMEOUT_MS = 20000;
/** Handles Utility-owned Agent open requests against Electron Main's native surface. */
export class MainOwnedMiniAppSurfaceBroker {
    constructor(options) {
        this.options = options;
        this.pendingByTarget = new Map();
        this.closePendingByTarget = new Map();
    }
    handleMessage(target, value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-surface-close') {
            const requestId = value.requestId;
            if (!isSafeBrokerRequestId(requestId))
                return true;
            if (!isMiniAppSurfaceCloseRequestMessage(value)) {
                this.postCloseError(target, requestId, 'invalid_request');
                return true;
            }
            this.startClose(target, value);
            return true;
        }
        if (value.type === 'miniapp-surface-sleep') {
            const requestId = value.requestId;
            if (!isSafeBrokerRequestId(requestId))
                return true;
            if (!isMiniAppSurfaceSleepRequestMessage(value)) {
                this.postSleepError(target, requestId, 'invalid_request');
                return true;
            }
            this.startSleep(target, value);
            return true;
        }
        if (value.type === 'miniapp-surface-open-cancel') {
            if (!isMiniAppSurfaceOpenCancelMessage(value))
                return true;
            this.abortRequest(target, value.requestId);
            return true;
        }
        if (value.type !== 'miniapp-surface-open')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        if (!isMiniAppSurfaceOpenRequestMessage(value)) {
            this.postError(target, requestId, 'invalid_request');
            return true;
        }
        this.startRequest(target, value);
        return true;
    }
    releaseTarget(target) {
        const pending = this.pendingByTarget.get(target);
        if (pending) {
            this.pendingByTarget.delete(target);
            for (const request of pending.values()) {
                if (request.settlementWatchdog)
                    clearTimeout(request.settlementWatchdog);
                request.controller.abort();
            }
        }
        const closes = this.closePendingByTarget.get(target);
        if (!closes)
            return;
        this.closePendingByTarget.delete(target);
        for (const request of closes.values()) {
            if (request.timeout)
                clearTimeout(request.timeout);
        }
    }
    pendingCount() {
        let count = 0;
        for (const pending of this.pendingByTarget.values())
            count += pending.size;
        for (const pending of this.closePendingByTarget.values())
            count += pending.size;
        return count;
    }
    startClose(target, message) {
        const close = this.options.close;
        this.runShortRequest(target, message.requestId, {
            run: close
                ? (isGenerationCurrent) => close({ pluginId: message.pluginId, isGenerationCurrent })
                : undefined,
            onResult: () => this.postCloseResult(target, message.requestId),
            onError: (code) => this.postCloseError(target, message.requestId, code === 'failed' ? 'close_failed' : code),
        });
    }
    startSleep(target, message) {
        const sleep = this.options.sleep;
        this.runShortRequest(target, message.requestId, {
            run: sleep
                ? (isGenerationCurrent) => sleep({
                    pluginId: message.pluginId,
                    ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
                    reason: message.reason,
                    notify: message.notify,
                    isGenerationCurrent,
                })
                : undefined,
            onResult: (outcome) => {
                const result = readSleepOutcome(outcome);
                if (!result) {
                    this.postSleepError(target, message.requestId, 'sleep_failed');
                    return;
                }
                this.postSleepResult(target, message.requestId, result);
            },
            onError: (code, error) => {
                if (code === 'failed') {
                    this.options.logger?.warn(`[MiniAppSurface] sleep failed plugin=${message.pluginId} session=${message.sessionId ?? '*'}: ${error instanceof Error ? error.message : String(error)}`);
                }
                this.postSleepError(target, message.requestId, code === 'failed' ? 'sleep_failed' : code);
            },
        });
    }
    /**
     * Close and sleep share one registry: no cancel message, a Main-side deadline, and a request id
     * that must not collide with any open, close or sleep still pending for the same Utility.
     */
    runShortRequest(target, requestId, handlers) {
        if (this.pendingByTarget.get(target)?.has(requestId)) {
            handlers.onError('invalid_request');
            return;
        }
        let pending = this.closePendingByTarget.get(target);
        if (!pending) {
            pending = new Map();
            this.closePendingByTarget.set(target, pending);
        }
        if (pending.has(requestId)) {
            handlers.onError('invalid_request');
            return;
        }
        const request = {};
        pending.set(requestId, request);
        const run = handlers.run;
        if (!run) {
            this.takePendingClose(target, requestId, request);
            handlers.onError('runtime_unavailable');
            return;
        }
        request.timeout = setTimeout(() => {
            if (!this.takePendingClose(target, requestId, request))
                return;
            handlers.onError('runtime_unavailable');
        }, SURFACE_SETTLEMENT_TIMEOUT_MS);
        request.timeout.unref?.();
        void Promise.resolve()
            .then(() => run(() => this.closePendingByTarget.get(target)?.get(requestId) === request))
            .then((value) => {
            if (!this.takePendingClose(target, requestId, request))
                return;
            handlers.onResult(value);
        }, (error) => {
            if (!this.takePendingClose(target, requestId, request))
                return;
            handlers.onError('failed', error);
        });
    }
    takePendingClose(target, requestId, expected) {
        const pending = this.closePendingByTarget.get(target);
        if (pending?.get(requestId) !== expected)
            return false;
        pending.delete(requestId);
        if (expected.timeout)
            clearTimeout(expected.timeout);
        if (pending.size === 0)
            this.closePendingByTarget.delete(target);
        return true;
    }
    postCloseResult(target, requestId) {
        try {
            target.postMessage({
                type: 'miniapp-surface-close-result',
                requestId,
            });
        }
        catch {
            // Utility exited between request settlement and delivery.
        }
    }
    postCloseError(target, requestId, code) {
        try {
            target.postMessage({
                type: 'miniapp-surface-close-error',
                requestId,
                code,
                message: SURFACE_CLOSE_ERROR_MESSAGES[code],
            });
        }
        catch {
            // Utility exited between request settlement and delivery.
        }
    }
    postSleepResult(target, requestId, outcome) {
        try {
            target.postMessage({
                type: 'miniapp-surface-sleep-result',
                requestId,
                ...outcome,
            });
        }
        catch {
            // Utility exited between request settlement and delivery.
        }
    }
    postSleepError(target, requestId, code) {
        try {
            target.postMessage({
                type: 'miniapp-surface-sleep-error',
                requestId,
                code,
                message: SURFACE_SLEEP_ERROR_MESSAGES[code],
            });
        }
        catch {
            // Utility exited between request settlement and delivery.
        }
    }
    startRequest(target, message) {
        if (this.closePendingByTarget.get(target)?.has(message.requestId)) {
            this.postError(target, message.requestId, 'busy');
            return;
        }
        let pending = this.pendingByTarget.get(target);
        if (!pending) {
            pending = new Map();
            this.pendingByTarget.set(target, pending);
        }
        const duplicate = pending.get(message.requestId);
        if (duplicate) {
            pending.delete(message.requestId);
            if (duplicate.settlementWatchdog)
                clearTimeout(duplicate.settlementWatchdog);
            duplicate.controller.abort();
            if (pending.size === 0)
                this.pendingByTarget.delete(target);
            this.postError(target, message.requestId, 'busy');
            return;
        }
        const request = { controller: new AbortController() };
        pending.set(message.requestId, request);
        void this.options
            .open({
            sessionId: message.sessionId,
            pluginId: message.pluginId,
            ...(message.path !== undefined ? { path: message.path } : {}),
            signal: request.controller.signal,
            isGenerationCurrent: () => this.pendingByTarget.get(target)?.get(message.requestId) === request,
        })
            .then(() => {
            if (!this.takePending(target, message.requestId, request))
                return;
            this.postResult(target, message.requestId);
        }, (error) => {
            if (!this.takePending(target, message.requestId, request))
                return;
            this.postError(target, message.requestId, normalizeSurfaceErrorCode(error));
        });
    }
    abortRequest(target, requestId) {
        const pending = this.pendingByTarget.get(target);
        const request = pending?.get(requestId);
        if (!pending || !request)
            return;
        // Keep the request registered until Main's operation settles. An abort
        // before the native-tab commit rejects; a completed commit resolves and
        // must remain authoritative for the Agent caller too.
        if (request.controller.signal.aborted)
            return;
        request.settlementWatchdog = setTimeout(() => {
            if (!this.takePending(target, requestId, request))
                return;
            this.postError(target, requestId, 'runtime_unavailable');
        }, SURFACE_SETTLEMENT_TIMEOUT_MS);
        request.settlementWatchdog.unref?.();
        request.controller.abort();
    }
    takePending(target, requestId, expected) {
        const pending = this.pendingByTarget.get(target);
        if (pending?.get(requestId) !== expected)
            return false;
        pending.delete(requestId);
        if (expected.settlementWatchdog)
            clearTimeout(expected.settlementWatchdog);
        if (pending.size === 0)
            this.pendingByTarget.delete(target);
        return true;
    }
    postError(target, requestId, code) {
        try {
            target.postMessage({
                type: 'miniapp-surface-open-error',
                requestId,
                code,
                message: SURFACE_ERROR_MESSAGES[code],
            });
        }
        catch {
            // Utility exited between request settlement and delivery.
        }
    }
    postResult(target, requestId) {
        try {
            target.postMessage({
                type: 'miniapp-surface-open-result',
                requestId,
            });
        }
        catch {
            // Utility exited between request settlement and delivery.
        }
    }
}

/** Utility-side client injected into the Agent Mini App lifecycle. */
export class UtilityMiniAppSurfaceClient {
    constructor(options) {
        this.options = options;
        this.pending = new Map();
        this.closePending = new Map();
        this.sleepPending = new Map();
        this.closed = false;
        this.requestTimeoutMs = options.requestTimeoutMs ?? SURFACE_REQUEST_TIMEOUT_MS;
        this.closeRequestTimeoutMs = options.closeRequestTimeoutMs ?? SURFACE_CLOSE_REQUEST_TIMEOUT_MS;
        if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
            throw new RangeError('Mini App surface requestTimeoutMs must be a positive finite number');
        }
        if (!Number.isFinite(this.closeRequestTimeoutMs) || this.closeRequestTimeoutMs <= 0) {
            throw new RangeError('Mini App surface closeRequestTimeoutMs must be a positive finite number');
        }
        this.port = {
            open: (input) => this.open(input),
            close: (input) => this.closeSurface(input),
            sleep: (input) => this.sleepSurface(input),
        };
    }
    handleMessage(value) {
        if (!isRecord(value))
            return false;
        if (value.type === 'miniapp-surface-sleep-result' ||
            value.type === 'miniapp-surface-sleep-error') {
            const requestId = value.requestId;
            if (!isSafeBrokerRequestId(requestId))
                return true;
            const pending = this.sleepPending.get(requestId);
            if (!pending)
                return true;
            this.sleepPending.delete(requestId);
            clearTimeout(pending.timeout);
            const outcome = readSleepResultMessage(value);
            if (outcome) {
                pending.resolve(outcome);
            }
            else if (isMiniAppSurfaceSleepErrorMessage(value)) {
                pending.reject(surfaceSleepError(value.code));
            }
            else {
                pending.reject(surfaceSleepError('invalid_request'));
            }
            return true;
        }
        if (value.type === 'miniapp-surface-close-result' ||
            value.type === 'miniapp-surface-close-error') {
            const requestId = value.requestId;
            if (!isSafeBrokerRequestId(requestId))
                return true;
            const pending = this.takePendingClose(requestId);
            if (!pending)
                return true;
            if (isMiniAppSurfaceCloseResultMessage(value)) {
                pending.resolve();
            }
            else if (isMiniAppSurfaceCloseErrorMessage(value)) {
                pending.reject(surfaceCloseError(value.code));
            }
            else {
                pending.reject(surfaceCloseError('invalid_request'));
            }
            return true;
        }
        if (value.type !== 'miniapp-surface-open-result' &&
            value.type !== 'miniapp-surface-open-error') {
            return false;
        }
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        const pending = this.takePending(requestId);
        if (!pending)
            return true;
        if (isMiniAppSurfaceOpenResultMessage(value)) {
            pending.resolve();
        }
        else if (isMiniAppSurfaceOpenErrorMessage(value)) {
            pending.reject(pending.cancellation === 'caller' ? abortError() : surfaceError(value.code));
        }
        else {
            pending.reject(pending.cancellation === 'caller' ? abortError() : surfaceError('invalid_request'));
        }
        return true;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const [requestId, pending] of this.pending) {
            try {
                this.options.postMessage({
                    type: 'miniapp-surface-open-cancel',
                    requestId,
                });
            }
            catch {
                // Main may already be gone.
            }
            this.cleanupPending(pending);
            pending.reject(surfaceError('runtime_unavailable'));
        }
        this.pending.clear();
        for (const pending of this.closePending.values()) {
            if (pending.timeout)
                clearTimeout(pending.timeout);
            pending.reject(surfaceCloseError('runtime_unavailable'));
        }
        this.closePending.clear();
        for (const pending of this.sleepPending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(surfaceSleepError('runtime_unavailable'));
        }
        this.sleepPending.clear();
    }
    pendingCount() {
        return this.pending.size + this.closePending.size + this.sleepPending.size;
    }
    hasPending(requestId) {
        return (this.pending.has(requestId) ||
            this.closePending.has(requestId) ||
            this.sleepPending.has(requestId));
    }
    /** Like close: no cancel message; the deadline rejects and Main's own deadline cleans up. */
    sleepSurface(input) {
        if (this.closed)
            return Promise.reject(surfaceSleepError('runtime_unavailable'));
        const requestId = (this.options.createRequestId ?? randomUUID)();
        const message = {
            type: 'miniapp-surface-sleep',
            requestId,
            pluginId: input.pluginId,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            reason: input.reason,
            notify: input.notify,
        };
        if (!isMiniAppSurfaceSleepRequestMessage(message) || this.hasPending(requestId)) {
            return Promise.reject(surfaceSleepError('invalid_request'));
        }
        // The main tsconfig targets a lib without `Promise.withResolvers`.
        return new Promise((resolve, reject) => {
            const pending = { resolve, reject };
            this.sleepPending.set(requestId, pending);
            pending.timeout = setTimeout(() => {
                if (this.sleepPending.get(requestId) !== pending)
                    return;
                this.sleepPending.delete(requestId);
                reject(surfaceSleepError('runtime_unavailable'));
            }, this.closeRequestTimeoutMs);
            pending.timeout.unref?.();
            try {
                this.options.postMessage(message);
            }
            catch {
                this.sleepPending.delete(requestId);
                clearTimeout(pending.timeout);
                reject(surfaceSleepError('runtime_unavailable'));
            }
        });
    }
    closeSurface(input) {
        if (this.closed)
            return Promise.reject(surfaceCloseError('runtime_unavailable'));
        const requestId = (this.options.createRequestId ?? randomUUID)();
        const message = {
            type: 'miniapp-surface-close',
            requestId,
            pluginId: input.pluginId,
        };
        if (!isMiniAppSurfaceCloseRequestMessage(message) || this.hasPending(requestId)) {
            return Promise.reject(surfaceCloseError('invalid_request'));
        }
        return new Promise((resolve, reject) => {
            const pending = { resolve, reject };
            this.closePending.set(requestId, pending);
            pending.timeout = setTimeout(() => {
                if (this.closePending.get(requestId) !== pending)
                    return;
                this.closePending.delete(requestId);
                reject(surfaceCloseError('runtime_unavailable'));
            }, this.closeRequestTimeoutMs);
            pending.timeout.unref?.();
            try {
                this.options.postMessage(message);
            }
            catch {
                this.closePending.delete(requestId);
                if (pending.timeout)
                    clearTimeout(pending.timeout);
                reject(surfaceCloseError('runtime_unavailable'));
            }
        });
    }
    takePendingClose(requestId) {
        const pending = this.closePending.get(requestId);
        if (!pending)
            return undefined;
        this.closePending.delete(requestId);
        if (pending.timeout)
            clearTimeout(pending.timeout);
        return pending;
    }
    open(input) {
        if (this.closed)
            return Promise.reject(surfaceError('runtime_unavailable'));
        if (input.signal?.aborted)
            return Promise.reject(abortError());
        const requestId = (this.options.createRequestId ?? randomUUID)();
        const message = {
            type: 'miniapp-surface-open',
            requestId,
            sessionId: input.sessionId,
            pluginId: input.pluginId,
            ...(input.path !== undefined ? { path: input.path } : {}),
        };
        if (!isMiniAppSurfaceOpenRequestMessage(message) || this.hasPending(requestId)) {
            return Promise.reject(surfaceError('invalid_request'));
        }
        return new Promise((resolve, reject) => {
            const pending = {
                resolve,
                reject,
                ...(input.signal ? { signal: input.signal } : {}),
                requestPosted: false,
            };
            this.pending.set(requestId, pending);
            pending.timeout = setTimeout(() => this.timeoutPending(requestId, pending), this.requestTimeoutMs);
            pending.timeout.unref?.();
            if (input.signal) {
                pending.abortListener = () => this.requestCancellation(requestId, pending);
                input.signal.addEventListener('abort', pending.abortListener, { once: true });
            }
            if (input.signal?.aborted || this.pending.get(requestId) !== pending) {
                this.requestCancellation(requestId, pending);
                return;
            }
            pending.requestPosted = true;
            try {
                this.options.postMessage(message);
            }
            catch {
                this.pending.delete(requestId);
                this.cleanupPending(pending);
                reject(pending.cancellation === 'caller' ? abortError() : surfaceError('runtime_unavailable'));
            }
        });
    }
    requestCancellation(requestId, expected, cancellation = 'caller') {
        if (this.pending.get(requestId) !== expected)
            return;
        if (!expected.requestPosted) {
            this.pending.delete(requestId);
            this.cleanupPending(expected);
            expected.reject(cancellation === 'caller' ? abortError() : surfaceError('runtime_unavailable'));
            return;
        }
        if (expected.cancellation)
            return;
        expected.cancellation = cancellation;
        try {
            this.options.postMessage({
                type: 'miniapp-surface-open-cancel',
                requestId,
            });
        }
        catch {
            this.pending.delete(requestId);
            this.cleanupPending(expected);
            expected.reject(cancellation === 'caller' ? abortError() : surfaceError('runtime_unavailable'));
            return;
        }
        if (this.pending.get(requestId) !== expected)
            return;
        expected.settlementWatchdog = setTimeout(() => {
            if (this.pending.get(requestId) !== expected)
                return;
            this.pending.delete(requestId);
            this.cleanupPending(expected);
            expected.reject(cancellation === 'caller' ? abortError() : surfaceError('runtime_unavailable'));
        }, SURFACE_SETTLEMENT_TIMEOUT_MS);
        expected.settlementWatchdog.unref?.();
    }
    timeoutPending(requestId, expected) {
        this.requestCancellation(requestId, expected, 'deadline');
    }
    takePending(requestId) {
        const pending = this.pending.get(requestId);
        if (!pending)
            return undefined;
        this.pending.delete(requestId);
        this.cleanupPending(pending);
        return pending;
    }
    cleanupPending(pending) {
        if (pending.timeout)
            clearTimeout(pending.timeout);
        if (pending.settlementWatchdog)
            clearTimeout(pending.settlementWatchdog);
        if (pending.signal && pending.abortListener) {
            pending.signal.removeEventListener('abort', pending.abortListener);
        }
    }
}

function normalizeSurfaceErrorCode(error) {
    if (error instanceof Error && error.name === 'AbortError') {
        return 'runtime_unavailable';
    }
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    return code === 'invalid_request' ||
        code === 'runtime_unavailable' ||
        code === 'not_found' ||
        code === 'busy' ||
        code === 'start_failed'
        ? code
        : 'start_failed';
}
function surfaceError(code) {
    return Object.assign(new Error(SURFACE_ERROR_MESSAGES[code]), { code });
}
function surfaceCloseError(code) {
    return Object.assign(new Error(SURFACE_CLOSE_ERROR_MESSAGES[code]), { code });
}
function surfaceSleepError(code) {
    return Object.assign(new Error(SURFACE_SLEEP_ERROR_MESSAGES[code]), { code });
}
function abortError() {
    return Object.assign(new Error('Mini App request was cancelled'), { name: 'AbortError' });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
function isSafeIdentifier(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        value.trim() === value &&
        !/[\u0000-\u001f\u007f]/u.test(value));
}
function isMiniAppSurfaceOpenRequestMessage(value) {
    // The Main-owned surface validates path syntax; the broker only bounds the wire value.
    return (isRecord(value) &&
        value.type === 'miniapp-surface-open' &&
        hasOnlyKeys(value, ['type', 'requestId', 'sessionId', 'pluginId', 'path']) &&
        isSafeBrokerRequestId(value.requestId) &&
        isSafeIdentifier(value.sessionId) &&
        isSafeIdentifier(value.pluginId) &&
        (value.path === undefined ||
            (typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 4096)));
}
function isMiniAppSurfaceCloseRequestMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-surface-close' &&
        hasOnlyKeys(value, ['type', 'requestId', 'pluginId']) &&
        isSafeBrokerRequestId(value.requestId) &&
        isSafeIdentifier(value.pluginId));
}
function isMiniAppSurfaceOpenCancelMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-surface-open-cancel' &&
        hasOnlyKeys(value, ['type', 'requestId']) &&
        isSafeBrokerRequestId(value.requestId));
}
function isMiniAppSurfaceOpenResultMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-surface-open-result' &&
        hasOnlyKeys(value, ['type', 'requestId']) &&
        isSafeBrokerRequestId(value.requestId));
}
function isMiniAppSurfaceCloseResultMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-surface-close-result' &&
        hasOnlyKeys(value, ['type', 'requestId']) &&
        isSafeBrokerRequestId(value.requestId));
}
function isMiniAppSurfaceOpenErrorMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp-surface-open-error')
        return false;
    if (!hasOnlyKeys(value, ['type', 'requestId', 'code', 'message']))
        return false;
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (value.code !== 'invalid_request' &&
        value.code !== 'runtime_unavailable' &&
        value.code !== 'not_found' &&
        value.code !== 'busy' &&
        value.code !== 'start_failed') {
        return false;
    }
    return value.message === SURFACE_ERROR_MESSAGES[value.code];
}
function isMiniAppSurfaceCloseErrorMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp-surface-close-error')
        return false;
    if (!hasOnlyKeys(value, ['type', 'requestId', 'code', 'message']))
        return false;
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (value.code !== 'invalid_request' &&
        value.code !== 'runtime_unavailable' &&
        value.code !== 'close_failed') {
        return false;
    }
    return value.message === SURFACE_CLOSE_ERROR_MESSAGES[value.code];
}
function isMiniAppSurfaceSleepRequestMessage(value) {
    return (isRecord(value) &&
        value.type === 'miniapp-surface-sleep' &&
        hasOnlyKeys(value, ['type', 'requestId', 'pluginId', 'sessionId', 'reason', 'notify']) &&
        isSafeBrokerRequestId(value.requestId) &&
        isSafeIdentifier(value.pluginId) &&
        (value.sessionId === undefined || isSafeIdentifier(value.sessionId)) &&
        isMiniAppSleepReason(value.reason) &&
        typeof value.notify === 'boolean');
}
function isSleepRefusal(value) {
    return SURFACE_SLEEP_REFUSALS.includes(value);
}
/** Rebuilds an outcome from `slept` / `refusal` only; `extraKeys` are the envelope's own fields. */
function readSleepOutcome(value, extraKeys = []) {
    if (!isRecord(value))
        return null;
    if (value.slept === true) {
        return hasOnlyKeys(value, [...extraKeys, 'slept']) ? { slept: true } : null;
    }
    return value.slept === false &&
        hasOnlyKeys(value, [...extraKeys, 'slept', 'refusal']) &&
        isSleepRefusal(value.refusal)
        ? { slept: false, refusal: value.refusal }
        : null;
}
function readSleepResultMessage(value) {
    if (value.type !== 'miniapp-surface-sleep-result' || !isSafeBrokerRequestId(value.requestId)) {
        return null;
    }
    return readSleepOutcome(value, ['type', 'requestId']);
}
function isMiniAppSurfaceSleepErrorMessage(value) {
    if (!isRecord(value) || value.type !== 'miniapp-surface-sleep-error')
        return false;
    if (!hasOnlyKeys(value, ['type', 'requestId', 'code', 'message']))
        return false;
    if (!isSafeBrokerRequestId(value.requestId))
        return false;
    if (value.code !== 'invalid_request' &&
        value.code !== 'runtime_unavailable' &&
        value.code !== 'sleep_failed') {
        return false;
    }
    return value.message === SURFACE_SLEEP_ERROR_MESSAGES[value.code];
}
