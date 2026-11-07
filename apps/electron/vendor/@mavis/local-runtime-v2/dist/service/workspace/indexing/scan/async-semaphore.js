export class AsyncSemaphore {
    maxConcurrency;
    active = 0;
    waiters = [];
    constructor(maxConcurrency) {
        this.maxConcurrency = maxConcurrency;
        if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
            throw new Error(`invalid_async_semaphore_concurrency:${maxConcurrency}`);
        }
    }
    async run(operation, signal) {
        await this.acquire(signal);
        try {
            return await operation();
        }
        finally {
            this.release();
        }
    }
    acquire(signal) {
        if (signal?.aborted)
            return Promise.reject(abortedError());
        if (this.active < this.maxConcurrency) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                signal,
                onAbort: undefined,
            };
            if (signal) {
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0)
                        this.waiters.splice(index, 1);
                    reject(abortedError());
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }
    release() {
        this.active -= 1;
        while (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            if (!waiter)
                break;
            if (waiter.onAbort)
                waiter.signal?.removeEventListener('abort', waiter.onAbort);
            if (waiter.signal?.aborted) {
                waiter.reject(abortedError());
                continue;
            }
            this.active += 1;
            waiter.resolve();
            return;
        }
    }
}
export function normalizeWorkspaceIndexingConcurrency(value, fallback) {
    if (value === undefined)
        return fallback;
    if (!Number.isFinite(value) || value < 1) {
        throw new Error(`invalid_workspace_indexing_concurrency:${value}`);
    }
    return Math.floor(value);
}
function abortedError() {
    return Object.assign(new Error('workspace_indexing_cancelled'), {
        name: 'AbortError',
        code: 'workspace_indexing_cancelled',
    });
}
//# sourceMappingURL=async-semaphore.js.map