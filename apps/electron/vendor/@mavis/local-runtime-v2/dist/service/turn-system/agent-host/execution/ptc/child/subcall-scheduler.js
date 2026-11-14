/**
 * A turn-local queue. A waiting sequential call blocks later parallel calls,
 * which lets writes become exclusive without allowing a read stream to starve
 * them forever.
 */
export class PtcSubcallScheduler {
    maxConcurrent;
    queue = [];
    active = new Set();
    drainWaiters = new Set();
    closed = false;
    constructor(maxConcurrent = 4) {
        this.maxConcurrent = maxConcurrent;
        if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
            throw new Error('PtcSubcallScheduler requires at least one parallel slot.');
        }
    }
    run(mode, task, signal) {
        if (this.closed)
            return Promise.reject(new Error('PTC subcall scheduler is closed.'));
        if (signal?.aborted)
            return Promise.reject(signal.reason ?? new Error('PTC subcall cancelled.'));
        return new Promise((resolve, reject) => {
            const controller = new AbortController();
            const item = {
                mode: mode ?? 'sequential',
                task,
                resolve,
                reject,
                controller,
                ...(signal
                    ? {
                        removeAbortListener: forwardAbort(signal, controller, () => {
                            const index = this.queue.indexOf(item);
                            if (index >= 0) {
                                this.queue.splice(index, 1);
                                reject(signal.reason ?? new Error('PTC subcall cancelled.'));
                                this.notifyDrained();
                                this.pump();
                            }
                        }),
                    }
                    : {}),
            };
            this.queue.push(item);
            this.pump();
        });
    }
    stop(reason = new Error('PTC subcall scheduler stopped.')) {
        if (this.closed)
            return;
        this.closed = true;
        for (const item of this.queue.splice(0)) {
            item.removeAbortListener?.();
            item.controller.abort(reason);
            item.reject(reason);
        }
        for (const item of this.active)
            item.controller.abort(reason);
        this.notifyDrained();
    }
    async drain() {
        if (this.queue.length === 0 && this.active.size === 0)
            return;
        await new Promise((resolve) => this.drainWaiters.add(resolve));
    }
    pump() {
        if (this.closed || this.activeSequential())
            return;
        for (;;) {
            const next = this.queue[0];
            if (!next) {
                this.notifyDrained();
                return;
            }
            if (next.mode === 'sequential') {
                if (this.active.size > 0)
                    return;
                this.start(this.queue.shift());
                return;
            }
            if (this.active.size >= this.maxConcurrent)
                return;
            this.start(this.queue.shift());
        }
    }
    start(item) {
        this.active.add(item);
        item.completion = this.executeTask(item);
    }
    async executeTask(item) {
        try {
            if (item.controller.signal.aborted)
                throw item.controller.signal.reason;
            item.resolve(await item.task(item.controller.signal));
        }
        catch (error) {
            item.reject(error);
        }
        finally {
            item.removeAbortListener?.();
            this.active.delete(item);
            this.notifyDrained();
            this.pump();
        }
    }
    activeSequential() {
        for (const item of this.active)
            if (item.mode === 'sequential')
                return true;
        return false;
    }
    notifyDrained() {
        if (this.queue.length !== 0 || this.active.size !== 0)
            return;
        for (const resolve of this.drainWaiters)
            resolve();
        this.drainWaiters.clear();
    }
}
function forwardAbort(source, target, onAbort) {
    const abort = () => {
        target.abort(source.reason);
        onAbort();
    };
    source.addEventListener('abort', abort, { once: true });
    return () => source.removeEventListener('abort', abort);
}
//# sourceMappingURL=subcall-scheduler.js.map