import { randomUUID } from "node:crypto";
import { isSafeBrokerRequestId, isAuthRecoveryRequestMessage, isStrictStructuredCloneValue, isAuthRecoveryResultMessage, isAuthRecoveryErrorMessage } from "./control";
const AUTH_RECOVERY_ERROR_MESSAGE = 'Desktop auth recovery failed';
export class MainOwnedAuthRecoveryBroker {
    constructor(options) {
        this.options = options;
    }
    handleMessage(target, value) {
        if (typeof value !== 'object' || value === null)
            return false;
        if (value.type !== 'auth-recovery-request')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        if (!isAuthRecoveryRequestMessage(value)) {
            this.postError(target, requestId);
            return true;
        }
        void Promise.resolve()
            .then(() => this.options.recoverAuthContext(value.rejectedAccessToken, value.loginEpoch))
            .then((authContext) => {
            if (!isStrictStructuredCloneValue(authContext)) {
                this.postError(target, requestId);
                return;
            }
            try {
                target.postMessage({ type: 'auth-recovery-result', requestId, authContext });
            }
            catch {
                // Utility exit raced result delivery.
            }
        }, () => this.postError(target, requestId));
        return true;
    }
    postError(target, requestId) {
        const message = {
            type: 'auth-recovery-error',
            requestId,
            message: AUTH_RECOVERY_ERROR_MESSAGE,
        };
        try {
            target.postMessage(message);
        }
        catch {
            // Utility exit raced error delivery.
        }
    }
}

export class UtilityAuthRecoveryBrokerClient {
    constructor(options) {
        this.options = options;
        this.pending = new Map();
        this.closed = false;
    }
    recover(rejectedAccessToken, loginEpoch) {
        if (this.closed)
            return Promise.reject(new Error(AUTH_RECOVERY_ERROR_MESSAGE));
        const requestId = (this.options.createRequestId ?? randomUUID)();
        const message = {
            type: 'auth-recovery-request',
            requestId,
            rejectedAccessToken,
            ...(loginEpoch === undefined ? {} : { loginEpoch }),
        };
        if (!isAuthRecoveryRequestMessage(message) || this.pending.has(requestId)) {
            return Promise.reject(new Error(AUTH_RECOVERY_ERROR_MESSAGE));
        }
        return new Promise((resolve, reject) => {
            this.pending.set(requestId, { resolve, reject });
            try {
                this.options.postMessage(message);
            }
            catch {
                this.pending.delete(requestId);
                reject(new Error(AUTH_RECOVERY_ERROR_MESSAGE));
            }
        });
    }
    handleMessage(value) {
        if (typeof value !== 'object' || value === null)
            return false;
        const type = value.type;
        if (type !== 'auth-recovery-result' && type !== 'auth-recovery-error')
            return false;
        const requestId = value.requestId;
        if (!isSafeBrokerRequestId(requestId))
            return true;
        const pending = this.pending.get(requestId);
        if (!pending)
            return true;
        this.pending.delete(requestId);
        if (isAuthRecoveryResultMessage(value)) {
            pending.resolve(value.authContext);
        }
        else if (isAuthRecoveryErrorMessage(value)) {
            pending.reject(new Error(value.message));
        }
        else {
            pending.reject(new Error(AUTH_RECOVERY_ERROR_MESSAGE));
        }
        return true;
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const pending of this.pending.values()) {
            pending.reject(new Error(AUTH_RECOVERY_ERROR_MESSAGE));
        }
        this.pending.clear();
    }
}

