import { HostConnectorProtocolError } from './host-connector-errors.js';
export class HostConnectorSessionLifecycle {
    #state = 'candidate';
    #everActivated = false;
    #activeQuiesce;
    isRetired() {
        return this.#state === 'retired';
    }
    isActive() {
        return this.#state === 'active';
    }
    gate() {
        if (this.#state === 'candidate' || this.#state === 'active')
            return 'open';
        return this.#everActivated ? 'service-restarted' : 'unavailable';
    }
    activate() {
        if (this.#state !== 'candidate') {
            throw new HostConnectorProtocolError('Host Connector cannot activate');
        }
        this.#everActivated = true;
        this.#state = 'active';
    }
    beginRetirement() {
        if (this.#state === 'retired')
            return false;
        this.#activeQuiesce = undefined;
        this.#state = 'draining';
        return true;
    }
    markRetired() {
        this.#state = 'retired';
    }
    beginQuiesce(input) {
        if (this.#state !== 'active') {
            throw new HostConnectorProtocolError('Host Connector cannot quiesce');
        }
        const token = Symbol('host-connector-quiesce');
        this.#activeQuiesce = token;
        this.#state = 'quiescing';
        let drained = false;
        const result = this.#recordQuiescence({
            token,
            pending: Promise.allSettled(input.pending),
            deadlineMs: input.deadlineMs,
            signal: input.signal,
            markDrained: () => {
                drained = true;
            },
        });
        return {
            result,
            resume: () => {
                if (!this.#ownsQuiesce(token))
                    return false;
                this.#activeQuiesce = undefined;
                this.#state = 'active';
                return true;
            },
            commit: async (options) => {
                if (!this.#ownsQuiesce(token) || !(drained || options?.force === true)) {
                    throw new HostConnectorProtocolError('Host Connector quiesce is not drained');
                }
                this.#activeQuiesce = undefined;
                this.#state = 'stale';
                input.commit(!drained);
            },
        };
    }
    #ownsQuiesce(token) {
        return this.#activeQuiesce === token && this.#state === 'quiescing';
    }
    async #recordQuiescence(input) {
        const outcome = await waitForHostConnectorQuiescence(input.pending, input.deadlineMs, input.signal);
        if (outcome !== 'drained' || !this.#ownsQuiesce(input.token))
            return 'busy';
        input.markDrained();
        return 'drained';
    }
}
export function createHostConnectorGatewayRelease(gateway, identity) {
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        gateway.releaseHostProcess({
            pluginId: identity.pluginId,
            processGeneration: identity.processGeneration,
        });
    };
}
async function waitForHostConnectorQuiescence(operation, deadlineMs, signal) {
    if (signal?.aborted || deadlineMs <= Date.now())
        return 'busy';
    let timer;
    let removeAbortListener;
    try {
        return await Promise.race([
            resolvesDrained(operation),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve('busy'), Math.max(0, deadlineMs - Date.now()));
                timer.unref();
            }),
            ...(signal
                ? [
                    new Promise((resolve) => {
                        const onAbort = () => resolve('busy');
                        signal.addEventListener('abort', onAbort, { once: true });
                        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
                    }),
                ]
                : []),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        removeAbortListener?.();
    }
}
async function resolvesDrained(operation) {
    await operation;
    return 'drained';
}
//# sourceMappingURL=host-connector-quiesce.js.map