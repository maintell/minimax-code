import { randomUUID } from "node:crypto";
import { ELECTRON_BROWSER_PUBLIC_ACTIONS } from "../../browser/electron-browser-route-policy";
import { BROWSER_BROKER_ERROR_DETAIL_MAX_LENGTH, isBrowserBrokerAbortMessage, isSafeBrokerRequestId, isBrowserBrokerRequestMessage, isStrictStructuredCloneValue, isBrowserBrokerResultMessage, isBrowserBrokerErrorMessage, isBrowserBrokerAction } from "./control";
const BROWSER_ERROR_MESSAGES = {
    aborted: 'Operation aborted',
    ambiguous_target: 'AMBIGUOUS_TARGET: Browser target is not unique; inspect and narrow it',
    browser_action_failed: 'Browser action failed in Electron main',
    browser_operation_timeout: 'Browser action timed out',
    browser_result_too_large: 'BROWSER_RESULT_TOO_LARGE: Browser result exceeded the safe response budget',
    background_render_busy: 'Background Browser render queue is busy',
    background_render_operation_timeout: 'Background Browser action timed out',
    background_render_queue_timeout: 'Background Browser render queue wait timed out',
    browser_unavailable: 'Browser broker is unavailable',
    browser_session_poisoned: 'BROWSER_SESSION_POISONED: Browser recovery could not isolate the previous action; open a new Browser tab and inspect it before continuing',
    current_tab_occupied: 'CURRENT_TAB_OCCUPIED: Current Browser tab already has a loaded page; retry with open_tab, or set replaceCurrentTab=true only when the user explicitly asked to reuse the current tab',
    duplicate_request: 'Duplicate Browser broker request',
    invalid_request: 'Invalid Browser broker request',
    invalid_result: 'Invalid Browser broker result',
    miniapp_tab_asleep: 'MINIAPP_TAB_ASLEEP: The selected Mini App tab is asleep to save memory; reopen it with the miniapp tool before using Browser on it',
    snapshot_continuation_mismatch: 'SNAPSHOT_CONTINUATION_MISMATCH: Continue with the exact nextOffset returned by Browser',
    snapshot_kind_mismatch: 'SNAPSHOT_KIND_MISMATCH: Continue the observation with its original Browser action',
    stale_element_ref: 'STALE_ELEMENT_REF: Browser target expired; inspect the current page again',
    stale_snapshot: 'STALE_SNAPSHOT: Browser observation expired; inspect the current page again',
    frame_coordinates_unavailable: 'FRAME_COORDINATES_UNAVAILABLE: Browser cannot safely address this frame by viewport coordinates; inspect the current page and choose a main-frame target',
};
const STRUCTURED_BROWSER_ERROR_CODES = {
    AMBIGUOUS_TARGET: 'ambiguous_target',
    ACTION_TIMEOUT: 'browser_operation_timeout',
    BROWSER_SESSION_POISONED: 'browser_session_poisoned',
    BROWSER_RESULT_TOO_LARGE: 'browser_result_too_large',
    CURRENT_TAB_OCCUPIED: 'current_tab_occupied',
    FRAME_COORDINATES_UNAVAILABLE: 'frame_coordinates_unavailable',
    MINIAPP_TAB_ASLEEP: 'miniapp_tab_asleep',
    SNAPSHOT_CONTINUATION_MISMATCH: 'snapshot_continuation_mismatch',
    SNAPSHOT_KIND_MISMATCH: 'snapshot_kind_mismatch',
    STALE_ELEMENT_REF: 'stale_element_ref',
    STALE_SNAPSHOT: 'stale_snapshot',
};
const BROWSER_BROKER_REQUEST_TIMEOUT_MS = 275000;
const SECRET_ASSIGNMENT_PATTERN = /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|apikey|key|secret|password|passwd|pwd|authorization|cookie|session[_-]?id|sid|signature|sig|credential[s]?)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;'")\]]+)/giu;
const BEARER_PATTERN = /\b(bearer|basic)\s+[a-z0-9._~+/=-]{8,}/giu;
const WINDOWS_PATH_PATTERN = /\b[a-z]:\\[^\s'"<>|]*/giu;
const POSIX_PRIVATE_PATH_PATTERN = /(^|[\s'"(=])(\/(?:Users|home|root|private|var\/folders|tmp)\/[^\s'"<>)]*)/gu;
/** An over-long detail keeps its ending, where Browser errors put their next step. */
const DETAIL_TAIL_CHARS = 280;
/**
 * The original exception tells the model why an action failed. Forward it
 * without credentials or local file paths: credential assignments,
 * Bearer/Basic tokens and local paths are removed, control characters and
 * runs of whitespace collapse. An over-long message keeps its start and end.
 */
export function redactBrowserErrorDetail(error) {
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const redacted = raw
        .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]')
        .replace(BEARER_PATTERN, '$1 [redacted]')
        .replace(WINDOWS_PATH_PATTERN, '[path]')
        .replace(POSIX_PRIVATE_PATH_PATTERN, '$1[path]')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!redacted)
        return undefined;
    if (redacted.length <= BROWSER_BROKER_ERROR_DETAIL_MAX_LENGTH)
        return redacted;
    const head = redacted.slice(0, BROWSER_BROKER_ERROR_DETAIL_MAX_LENGTH - DETAIL_TAIL_CHARS - 1);
    return `${head}…${redacted.slice(-DETAIL_TAIL_CHARS)}`;
}
function browserBrokerErrorCode(error, aborted) {
    if (aborted)
        return 'aborted';
    const code = error && typeof error === 'object' && 'code' in error
        ? error.code
        : undefined;
    if (code === 'BACKGROUND_RENDER_BUSY')
        return 'background_render_busy';
    if (code === 'BACKGROUND_RENDER_OPERATION_TIMEOUT') {
        return 'background_render_operation_timeout';
    }
    if (code === 'BACKGROUND_RENDER_QUEUE_TIMEOUT')
        return 'background_render_queue_timeout';
    if (code === 'BROWSER_OPERATION_TIMEOUT')
        return 'browser_operation_timeout';
    const message = error instanceof Error ? error.message : String(error);
    const structuredCode = /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1];
    if (structuredCode && STRUCTURED_BROWSER_ERROR_CODES[structuredCode]) {
        return STRUCTURED_BROWSER_ERROR_CODES[structuredCode];
    }
    return 'browser_action_failed';
}
/**
 * The redacted original message for the generic failure and allowlisted
 * recovery codes. Timeouts keep their label/deadline contract instead.
 */
function browserBrokerErrorDetail(code, error) {
    const actionable = code === 'browser_action_failed' ||
        (code !== 'browser_operation_timeout' &&
            Object.values(STRUCTURED_BROWSER_ERROR_CODES).includes(code));
    if (!actionable)
        return undefined;
    const detail = redactBrowserErrorDetail(error);
    if (!detail || detail === BROWSER_ERROR_MESSAGES[code])
        return undefined;
    // A recovery cause the fixed guidance already states adds nothing.
    const cause = detail.replace(/^[A-Z][A-Z0-9_]+:\s*/u, '');
    if (code !== 'browser_action_failed' && BROWSER_ERROR_MESSAGES[code].includes(cause)) {
        return undefined;
    }
    return detail;
}
function postBrowserError(target, requestId, code, onDeliveryFailure, error, detail) {
    const source = error && typeof error === 'object' ? error : {};
    const label = 'label' in source && typeof source.label === 'string' ? source.label.trim().slice(0, 200) : '';
    const timeoutMs = 'timeoutMs' in source &&
        typeof source.timeoutMs === 'number' &&
        Number.isFinite(source.timeoutMs) &&
        source.timeoutMs > 0
        ? source.timeoutMs
        : undefined;
    const message = {
        type: 'browser-error',
        requestId,
        code,
        message: BROWSER_ERROR_MESSAGES[code],
        ...(detail ? { detail } : {}),
        ...(label ? { label } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    postBrowserMessage(target, message, requestId, 'browser-error', onDeliveryFailure);
}
function postBrowserMessage(target, message, requestId, messageType, onDeliveryFailure) {
    try {
        target.postMessage(message);
    }
    catch (error) {
        const failure = {
            requestId,
            messageType,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        };
        try {
            onDeliveryFailure?.(failure);
        }
        catch {
            // Diagnostics must never reopen or change the settled broker request.
        }
    }
}
export class MainOwnedBrowserBroker {
    constructor(options) {
        this.options = options;
        this.pendingByTarget = new Map();
    }
    handleMessage(target, value) {
        if (typeof value !== 'object' || value === null)
            return false;
        const type = value.type;
        if (type === 'browser-abort') {
            if (!isBrowserBrokerAbortMessage(value))
                return true;
            this.abortRequest(target, value.requestId);
            return true;
        }
        if (type !== 'browser-request')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        if (!isBrowserBrokerRequestMessage(value)) {
            this.postError(target, requestId, 'invalid_request');
            return true;
        }
        this.startRequest(target, value);
        return true;
    }
    releaseTarget(target) {
        const pending = this.pendingByTarget.get(target);
        if (!pending)
            return;
        this.pendingByTarget.delete(target);
        for (const request of pending.values())
            request.controller.abort();
    }
    pendingCount() {
        let count = 0;
        for (const pending of this.pendingByTarget.values())
            count += pending.size;
        return count;
    }
    startRequest(target, message) {
        let targetPending = this.pendingByTarget.get(target);
        if (!targetPending) {
            targetPending = new Map();
            this.pendingByTarget.set(target, targetPending);
        }
        const duplicate = targetPending.get(message.requestId);
        if (duplicate) {
            targetPending.delete(message.requestId);
            duplicate.controller.abort();
            if (targetPending.size === 0)
                this.pendingByTarget.delete(target);
            this.postError(target, message.requestId, 'duplicate_request');
            return;
        }
        let adapter;
        try {
            adapter = this.options.getAdapter();
        }
        catch {
            this.postError(target, message.requestId, 'browser_unavailable');
            return;
        }
        if (!adapter) {
            this.postError(target, message.requestId, 'browser_unavailable');
            return;
        }
        const activeAdapter = adapter;
        const pending = { controller: new AbortController() };
        targetPending.set(message.requestId, pending);
        void Promise.resolve()
            .then(() => activeAdapter.execute(message.context, message.action, message.input, pending.controller.signal))
            .then((result) => {
            if (!this.takePending(target, message.requestId, pending))
                return;
            if (!isStrictStructuredCloneValue(result)) {
                this.postError(target, message.requestId, 'invalid_result');
                return;
            }
            postBrowserMessage(target, {
                type: 'browser-result',
                requestId: message.requestId,
                result,
            }, message.requestId, 'browser-result', this.options.onDeliveryFailure);
        }, (error) => {
            if (!this.takePending(target, message.requestId, pending))
                return;
            const code = browserBrokerErrorCode(error, pending.controller.signal.aborted);
            const detail = browserBrokerErrorDetail(code, error);
            try {
                this.options.onActionFailure?.({
                    requestId: message.requestId,
                    sessionId: message.context.sessionId,
                    action: message.action,
                    code,
                    ...(detail ? { detail } : {}),
                });
            }
            catch {
                // Diagnostics must never change the settled broker request.
            }
            postBrowserError(target, message.requestId, code, this.options.onDeliveryFailure, error, detail);
        });
    }
    postError(target, requestId, code) {
        postBrowserError(target, requestId, code, this.options.onDeliveryFailure);
    }
    abortRequest(target, requestId) {
        const pending = this.pendingByTarget.get(target);
        const request = pending?.get(requestId);
        if (!pending || !request)
            return;
        pending.delete(requestId);
        if (pending.size === 0)
            this.pendingByTarget.delete(target);
        request.controller.abort();
    }
    takePending(target, requestId, expected) {
        const pending = this.pendingByTarget.get(target);
        if (pending?.get(requestId) !== expected)
            return false;
        pending.delete(requestId);
        if (pending.size === 0)
            this.pendingByTarget.delete(target);
        return true;
    }
}

function browserBrokerClientError(message) {
    const detailCode = message.code === 'browser_action_failed' && message.detail
        ? /^([A-Z][A-Z0-9_]+):/u.exec(message.detail)?.[1]
        : undefined;
    const code = message.code === 'aborted'
        ? 'ABORTED'
        : message.code === 'browser_session_poisoned'
            ? 'BROWSER_SESSION_POISONED'
            : message.code === 'frame_coordinates_unavailable'
                ? 'FRAME_COORDINATES_UNAVAILABLE'
                : message.code === 'browser_operation_timeout' ||
                    message.code === 'background_render_operation_timeout' ||
                    message.code === 'background_render_queue_timeout'
                    ? 'BROWSER_OPERATION_TIMEOUT'
                    : (detailCode ?? message.code);
    // The generic failure shows the original (redacted) message itself; an
    // allowlisted recovery code keeps its fixed guidance and appends the cause.
    const publicMessage = code === 'BROWSER_OPERATION_TIMEOUT' && message.label && message.timeoutMs !== undefined
        ? `BROWSER_OPERATION_TIMEOUT: Operation "${message.label}" exceeded ${message.timeoutMs}ms`
        : message.detail === undefined
            ? message.message
            : message.code === 'browser_action_failed'
                ? message.detail
                : `${message.message} (${message.detail.replace(/^[A-Z][A-Z0-9_]+:\s*/u, '')})`;
    return Object.assign(new Error(publicMessage), {
        code,
        brokerCode: message.code,
        ...(message.label ? { label: message.label } : {}),
        ...(message.timeoutMs !== undefined ? { timeoutMs: message.timeoutMs } : {}),
    });
}
export class UtilityBrowserBrokerClient {
    constructor(options) {
        this.options = options;
        this.pending = new Map();
        this.closed = false;
        this.requestTimeoutMs = options.requestTimeoutMs ?? BROWSER_BROKER_REQUEST_TIMEOUT_MS;
        if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
            throw new RangeError('Browser broker requestTimeoutMs must be a positive finite number');
        }
        this.adapter = {
            getCapabilities: () => ({
                // The broker is only the Utility Host transport for the Electron
                // FilePanel provider; preserve that provider identity for feature gates.
                provider: 'electron-file-panel',
                version: 1,
                // The wire protocol accepts a few legacy/internal actions that are
                // intentionally absent from the model-facing Electron capability.
                actions: ELECTRON_BROWSER_PUBLIC_ACTIONS,
                interactiveTakeover: true,
            }),
            execute: (context, action, input, signal) => this.execute(context, action, input, signal),
        };
    }
    handleMessage(value) {
        if (typeof value !== 'object' || value === null)
            return false;
        const type = value.type;
        if (type !== 'browser-result' && type !== 'browser-error')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        const pending = this.takePending(requestId);
        if (!pending)
            return true;
        if (isBrowserBrokerResultMessage(value)) {
            pending.resolve(value.result);
        }
        else if (isBrowserBrokerErrorMessage(value)) {
            pending.reject(browserBrokerClientError(value));
        }
        else {
            pending.reject(new Error('Invalid Browser broker response'));
        }
        return true;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const [requestId, pending] of this.pending) {
            try {
                this.options.postMessage({ type: 'browser-abort', requestId });
            }
            catch {
                // Main may already be gone.
            }
            this.cleanupPending(pending);
            pending.reject(new Error(BROWSER_ERROR_MESSAGES.browser_unavailable));
        }
        this.pending.clear();
    }
    pendingCount() {
        return this.pending.size;
    }
    execute(context, action, input, signal) {
        if (this.closed)
            return Promise.reject(new Error(BROWSER_ERROR_MESSAGES.browser_unavailable));
        if (signal?.aborted)
            return Promise.reject(new Error(BROWSER_ERROR_MESSAGES.aborted));
        if (!isBrowserBrokerAction(action)) {
            return Promise.reject(new Error(`Unsupported Electron Browser action: ${action}`));
        }
        const requestId = (this.options.createRequestId ?? randomUUID)();
        if (!isSafeBrokerRequestId(requestId) || this.pending.has(requestId)) {
            return Promise.reject(new Error(BROWSER_ERROR_MESSAGES.duplicate_request));
        }
        const message = {
            type: 'browser-request',
            requestId,
            context: {
                sessionId: context.sessionId,
                turnId: context.turnId,
                ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
                ...(context.browserAssets
                    ? {
                        browserAssets: context.browserAssets.map((asset) => ({
                            filePath: asset.filePath,
                            fileName: asset.fileName,
                            mimeType: asset.mimeType,
                        })),
                    }
                    : {}),
            },
            action,
            input,
        };
        if (!isBrowserBrokerRequestMessage(message)) {
            return Promise.reject(new Error(BROWSER_ERROR_MESSAGES.invalid_request));
        }
        return new Promise((resolve, reject) => {
            const pending = { resolve, reject, signal, requestPosted: false };
            this.pending.set(requestId, pending);
            pending.timeout = setTimeout(() => this.timeoutPending(requestId, pending), this.requestTimeoutMs);
            pending.timeout.unref?.();
            if (signal) {
                pending.abortListener = () => this.abortPending(requestId, pending);
                signal.addEventListener('abort', pending.abortListener, { once: true });
                if (signal.aborted || this.pending.get(requestId) !== pending) {
                    this.abortPending(requestId, pending);
                    return;
                }
            }
            pending.requestPosted = true;
            try {
                this.options.postMessage(message);
            }
            catch {
                this.pending.delete(requestId);
                this.cleanupPending(pending);
                reject(new Error(BROWSER_ERROR_MESSAGES.browser_unavailable));
            }
        });
    }
    abortPending(requestId, expected) {
        if (this.pending.get(requestId) !== expected)
            return;
        this.pending.delete(requestId);
        this.cleanupPending(expected);
        if (expected.requestPosted) {
            try {
                this.options.postMessage({ type: 'browser-abort', requestId });
            }
            catch {
                // The local abort result still settles deterministically.
            }
        }
        expected.reject(new Error(BROWSER_ERROR_MESSAGES.aborted));
    }
    timeoutPending(requestId, expected) {
        if (this.pending.get(requestId) !== expected)
            return;
        this.pending.delete(requestId);
        this.cleanupPending(expected);
        if (expected.requestPosted) {
            try {
                this.options.postMessage({ type: 'browser-abort', requestId });
            }
            catch {
                // The watchdog still settles and releases Utility pending state.
            }
        }
        expected.reject(browserBrokerClientError({
            type: 'browser-error',
            requestId,
            code: 'browser_operation_timeout',
            message: BROWSER_ERROR_MESSAGES.browser_operation_timeout,
            label: 'Browser broker response',
            timeoutMs: this.requestTimeoutMs,
        }));
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
        if (pending.signal && pending.abortListener) {
            pending.signal.removeEventListener('abort', pending.abortListener);
        }
    }
}

