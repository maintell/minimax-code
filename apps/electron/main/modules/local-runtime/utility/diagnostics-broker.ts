import { randomUUID } from "node:crypto";
import { DIAGNOSTICS_BROKER_METHODS, isSafeBrokerRequestId, isDiagnosticsBrokerRequestMessage, isStrictStructuredCloneRecord, isDiagnosticsBrokerResultMessage, isDiagnosticsBrokerErrorMessage } from "./control";
const DIAGNOSTICS_ERROR_MESSAGES = {
    diagnostics_request_failed: 'Electron diagnostics request failed',
    duplicate_request: 'Duplicate diagnostics broker request',
    invalid_request: 'Invalid diagnostics broker request',
    invalid_result: 'Invalid diagnostics broker result',
    unsupported_method: 'Unsupported diagnostics broker method',
};
const DIAGNOSTICS_METHOD_SET = new Set(DIAGNOSTICS_BROKER_METHODS);
const BODY_METHODS = new Set(['uploadDiagnosticBundle']);
const CAPABILITY_BY_METHOD = {
    uploadDiagnosticBundle: 'diagnostic-upload',
};
function unavailable(capability) {
    return {
        available: false,
        error: 'host_diagnostics_unavailable',
        capability,
        reason: 'No host diagnostics provider is registered for this local runtime owner.',
    };
}
function postDiagnosticsError(target, requestId, code) {
    const message = {
        type: 'diagnostics-error',
        requestId,
        code,
        message: DIAGNOSTICS_ERROR_MESSAGES[code],
    };
    try {
        target.postMessage(message);
    }
    catch {
        // Utility exit raced the response.
    }
}
export class MainOwnedDiagnosticsBroker {
    constructor(options) {
        this.options = options;
        this.pendingByTarget = new Map();
    }
    handleMessage(target, value) {
        if (typeof value !== 'object' || value === null)
            return false;
        if (value.type !== 'diagnostics-request')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        if (!isDiagnosticsBrokerRequestMessage(value)) {
            postDiagnosticsError(target, requestId, 'invalid_request');
            return true;
        }
        if (!DIAGNOSTICS_METHOD_SET.has(value.method)) {
            postDiagnosticsError(target, requestId, 'unsupported_method');
            return true;
        }
        const method = value.method;
        if (BODY_METHODS.has(method) !== (value.body !== undefined)) {
            postDiagnosticsError(target, requestId, 'invalid_request');
            return true;
        }
        let pending = this.pendingByTarget.get(target);
        if (!pending) {
            pending = new Map();
            this.pendingByTarget.set(target, pending);
        }
        if (pending.has(requestId)) {
            pending.delete(requestId);
            if (pending.size === 0)
                this.pendingByTarget.delete(target);
            postDiagnosticsError(target, requestId, 'duplicate_request');
            return true;
        }
        const pendingRequest = { requestId };
        pending.set(requestId, pendingRequest);
        void Promise.resolve()
            .then(() => this.dispatch(this.options.getProvider(), method, value.body))
            .then((result) => {
            if (!this.takePending(target, requestId, pendingRequest))
                return;
            if (!isStrictStructuredCloneRecord(result)) {
                postDiagnosticsError(target, requestId, 'invalid_result');
                return;
            }
            try {
                target.postMessage({ type: 'diagnostics-result', requestId, result });
            }
            catch {
                // Utility exit raced result delivery.
            }
        }, () => {
            if (!this.takePending(target, requestId, pendingRequest))
                return;
            postDiagnosticsError(target, requestId, 'diagnostics_request_failed');
        });
        return true;
    }
    releaseTarget(target) {
        this.pendingByTarget.delete(target);
    }
    pendingCount() {
        let count = 0;
        for (const pending of this.pendingByTarget.values())
            count += pending.size;
        return count;
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
    async dispatch(provider, method, body) {
        const fn = provider?.[method];
        if (!fn)
            return unavailable(CAPABILITY_BY_METHOD[method]);
        return fn.call(provider, body ?? {});
    }
}

export class UtilityDiagnosticsBrokerClient {
    constructor(options) {
        this.options = options;
        this.pending = new Map();
        this.closed = false;
        this.provider = {
            uploadDiagnosticBundle: (body) => this.request('uploadDiagnosticBundle', body),
        };
    }
    handleMessage(value) {
        if (typeof value !== 'object' || value === null)
            return false;
        const type = value.type;
        if (type !== 'diagnostics-result' && type !== 'diagnostics-error')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        const pending = this.pending.get(requestId);
        if (!pending)
            return true;
        this.pending.delete(requestId);
        if (isDiagnosticsBrokerResultMessage(value)) {
            pending.resolve(value.result);
        }
        else if (isDiagnosticsBrokerErrorMessage(value)) {
            pending.reject(new Error(value.message));
        }
        else {
            pending.reject(new Error('Invalid diagnostics broker response'));
        }
        return true;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(new Error('Diagnostics broker is unavailable'));
        }
        this.pending.clear();
    }
    pendingCount() {
        return this.pending.size;
    }
    request(method, body) {
        if (this.closed)
            return Promise.reject(new Error('Diagnostics broker is unavailable'));
        const requestId = (this.options.createRequestId ?? randomUUID)();
        if (!isSafeBrokerRequestId(requestId) || this.pending.has(requestId)) {
            return Promise.reject(new Error(DIAGNOSTICS_ERROR_MESSAGES.duplicate_request));
        }
        const message = {
            type: 'diagnostics-request',
            requestId,
            method,
            ...(body === undefined ? {} : { body }),
        };
        if (!isDiagnosticsBrokerRequestMessage(message)) {
            return Promise.reject(new Error(DIAGNOSTICS_ERROR_MESSAGES.invalid_request));
        }
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            try {
                this.options.postMessage(message);
            }
            catch {
                this.pending.delete(requestId);
                reject(new Error('Diagnostics broker is unavailable'));
            }
        });
    }
}

