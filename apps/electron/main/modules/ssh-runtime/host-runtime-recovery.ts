import { randomUUID } from "node:crypto";
import { HostConnectionScheduler, HostConnectionController } from "./host-connection-controller.js";
/** Profile-scoped scheduling and same-channel health; no remote task is replayed. */
export class HostRuntimeRecovery {
    constructor(options) {
        this.options = options;
        this.controllers = new Map();
        this.scheduler = new HostConnectionScheduler(3);
        this.idleOperations = new Map();
        this.healthTimers = new Map();
        this.healthChecks = new Map();
    }
    get(host) {
        const existing = this.controllers.get(host);
        if (existing)
            return existing;
        const configuration = this.options.configure(host);
        const controller = new HostConnectionController({
            ...configuration,
            hostId: host,
            scheduler: this.scheduler,
            onReady: (value, snapshot) => {
                if (!this.healthTimers.has(host)) {
                    const timer = setInterval(() => this.checkHealth(host, controller), 30000);
                    timer.unref?.();
                    this.healthTimers.set(host, timer);
                }
                return configuration.onReady?.(value, snapshot);
            },
            onSnapshot: (snapshot) => {
                if (snapshot.state !== 'ready')
                    this.clearHealth(host);
                this.options.onSnapshot(host, snapshot);
            },
        });
        this.controllers.set(host, controller);
        return controller;
    }
    /** Short operations keep an idle grace so media Range reads share one channel. */
    retainOperation(host) {
        const controller = this.get(host);
        const key = `operation:${randomUUID()}`;
        controller.retainDemand(key);
        this.clearIdle(host);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            if (this.controllers.get(host) === controller && controller.getSnapshot().state === 'ready') {
                const idleKey = `idle:${randomUUID()}`;
                controller.retainDemand(idleKey);
                this.clearIdle(host);
                const timer = setTimeout(() => {
                    if (this.idleOperations.get(host)?.key === idleKey)
                        this.clearIdle(host);
                }, 30000);
                timer.unref?.();
                this.idleOperations.set(host, { controller, key: idleKey, timer });
            }
            controller.releaseDemand(key);
        };
    }
    clearIdle(host) {
        const idle = this.idleOperations.get(host);
        if (!idle)
            return;
        this.idleOperations.delete(host);
        clearTimeout(idle.timer);
        idle.controller.releaseDemand(idle.key);
    }
    peek(host) {
        return this.controllers.get(host);
    }
    setPriority(host, priority) {
        this.controllers.get(host)?.setPriority(priority);
    }
    hint(reason) {
        for (const [host, controller] of this.controllers) {
            if (controller.getSnapshot().state === 'ready')
                this.checkHealth(host, controller);
            else
                controller.hint(reason);
        }
    }
    reset(host) {
        const controller = this.controllers.get(host);
        this.controllers.delete(host);
        this.clearIdle(host);
        this.clearHealth(host);
        controller?.dispose();
    }
    dispose() {
        for (const host of this.controllers.keys())
            this.reset(host);
    }
    checkHealth(host, controller) {
        const snapshot = controller.getSnapshot();
        if (snapshot.state !== 'ready' || snapshot.demandCount === 0 || this.healthChecks.has(host))
            return;
        const abort = new AbortController();
        this.healthChecks.set(host, abort);
        void controller
            .connect()
            .then(async (result) => {
            if (!result.connected || abort.signal.aborted)
                return;
            await result.value.healthCheck?.(abort.signal);
        })
            .catch(() => {
            if (!abort.signal.aborted &&
                this.controllers.get(host) === controller &&
                controller.getSnapshot().generation === snapshot.generation) {
                controller.markLost({
                    code: 'runtime_connection_lost',
                    message: 'SSH transport health check timed out or failed.',
                });
            }
        })
            .finally(() => {
            if (this.healthChecks.get(host) === abort)
                this.healthChecks.delete(host);
        });
    }
    clearHealth(host) {
        const timer = this.healthTimers.get(host);
        if (timer)
            clearInterval(timer);
        this.healthTimers.delete(host);
        this.healthChecks.get(host)?.abort();
        this.healthChecks.delete(host);
    }
}

/** Cancelling one waiter never aborts an independently owned install/probe. */
export function waitForHostOperation(operation, signal) {
    return new Promise((resolve, reject) => {
        const cancel = () => reject(Object.assign(new Error('SSH attempt cancelled.'), { code: 'ssh_cancelled' }));
        if (signal.aborted) {
            operation.catch(() => undefined);
            cancel();
            return;
        }
        signal.addEventListener('abort', cancel, { once: true });
        operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
    });
}
