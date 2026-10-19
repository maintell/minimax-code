const DEFAULT_READY_TIMEOUT_MS = 35000;
/** Child-side request broker for lazily attaching the sibling CUA utility. */
export class UtilityComputerUseBrokerClient {
    constructor(port, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.ready = false;
        this.sequence = 0;
    }
    ensureReady() {
        if (this.ready)
            return Promise.resolve();
        if (this.pending)
            return this.pending.promise;
        const requestId = `computer-use-ready-${Date.now().toString(36)}-${++this.sequence}`;
        let resolve;
        let reject;
        const promise = new Promise((accept, deny) => {
            resolve = accept;
            reject = deny;
        });
        const timer = setTimeout(() => {
            if (this.pending?.requestId !== requestId)
                return;
            this.pending = undefined;
            reject(new Error('computer_utility_start_timeout'));
        }, this.timeoutMs);
        timer.unref?.();
        this.pending = { requestId, promise, resolve, reject, timer };
        try {
            this.port.postMessage({ type: 'runtime-computer-use-required', requestId });
        }
        catch {
            this.settle(false);
        }
        return promise;
    }
    markReady() {
        this.ready = true;
        this.settle(true);
    }
    markUnavailable() {
        this.ready = false;
    }
    handleMessage(message) {
        if (!isRuntimeComputerUseReadyMessage(message))
            return false;
        if (message.requestId !== this.pending?.requestId)
            return true;
        if (message.ready)
            this.markReady();
        else
            this.settle(false);
        return true;
    }
    settle(ready) {
        const pending = this.pending;
        if (!pending)
            return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (ready)
            pending.resolve();
        else
            pending.reject(new Error('computer_unavailable'));
    }
}

export function isRuntimeComputerUseRequiredMessage(value) {
    return (isRecord(value) &&
        value.type === 'runtime-computer-use-required' &&
        typeof value.requestId === 'string' &&
        value.requestId.length > 0 &&
        value.requestId.length <= 128);
}
function isRuntimeComputerUseReadyMessage(value) {
    return (isRecord(value) &&
        value.type === 'runtime-computer-use-ready' &&
        typeof value.requestId === 'string' &&
        value.requestId.length > 0 &&
        value.requestId.length <= 128 &&
        typeof value.ready === 'boolean');
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Reconnect before a new admitted action; never replay an interrupted action. */
export function createReconnectingComputerUseClient(broker, getClient) {
    return {
        ensureReady: () => broker.ensureReady(),
        async call(request, signal) {
            signal?.throwIfAborted();
            await broker.ensureReady();
            signal?.throwIfAborted();
            return getClient().call(request, signal);
        },
        release: (sessionId, turnId) => getClient().release?.(sessionId, turnId),
    };
}
