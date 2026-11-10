export function createSessionHistoryCompactionBarrier() {
    const lane = createSessionHistoryIoLane();
    const active = new Map();
    return {
        async begin(sessionId, attemptId, turnId) {
            const release = await lane.acquire(sessionId);
            active.set(sessionId, { attemptId, turnId, release });
        },
        end: (sessionId, attemptId) => {
            const entry = active.get(sessionId);
            if (entry?.attemptId !== attemptId)
                return;
            active.delete(sessionId);
            entry.release();
        },
        endTurn: (sessionId, turnId) => {
            const entry = active.get(sessionId);
            if (entry?.turnId !== turnId)
                return;
            active.delete(sessionId);
            entry.release();
        },
        async run(sessionId, capture, signal) {
            if (!signal)
                return lane.run(sessionId, capture);
            signal.throwIfAborted();
            let aborted;
            const cancelled = new Promise((_resolve, reject) => {
                aborted = () => reject(signal.reason);
                signal.addEventListener('abort', aborted, { once: true });
            });
            const pending = lane.run(sessionId, async () => {
                signal.removeEventListener('abort', aborted);
                signal.throwIfAborted();
                return capture();
            });
            try {
                return await Promise.race([pending, cancelled]);
            }
            finally {
                signal.removeEventListener('abort', aborted);
            }
        },
    };
}
/** Serializes physical history I/O shared by the canonical provider and mutation adapter. */
export function createSessionHistoryIoLane() {
    const lanes = new Map();
    async function acquire(sessionId) {
        const previous = lanes.get(sessionId) ?? Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });
        lanes.set(sessionId, current);
        await previous;
        return () => {
            release();
            if (lanes.get(sessionId) === current)
                lanes.delete(sessionId);
        };
    }
    return {
        acquire,
        async run(sessionId, operation) {
            const release = await acquire(sessionId);
            try {
                return await operation();
            }
            finally {
                release();
            }
        },
    };
}
/** Lossless versioned notification used when Display commits just before canonical history. */
export function createSessionHistoryActivity() {
    const versions = new Map();
    const waiters = new Map();
    return {
        version: (sessionId) => versions.get(sessionId) ?? 0,
        notify: (sessionId) => {
            const next = (versions.get(sessionId) ?? 0) + 1;
            versions.set(sessionId, next);
            for (const waiter of waiters.get(sessionId) ?? []) {
                if (next > waiter.afterVersion)
                    waiter.settle(true);
            }
        },
        waitForChange: (sessionId, afterVersion, timeoutMs) => {
            if ((versions.get(sessionId) ?? 0) > afterVersion)
                return Promise.resolve(true);
            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
                return Promise.resolve(false);
            return new Promise((resolve) => {
                const entries = waiters.get(sessionId) ?? new Set();
                let timer;
                const waiter = {
                    afterVersion,
                    settle: (changed) => {
                        if (!entries.delete(waiter))
                            return;
                        if (timer)
                            clearTimeout(timer);
                        if (entries.size === 0)
                            waiters.delete(sessionId);
                        resolve(changed);
                    },
                };
                entries.add(waiter);
                waiters.set(sessionId, entries);
                timer = setTimeout(() => waiter.settle(false), Math.floor(timeoutMs));
                timer.unref?.();
            });
        },
    };
}
//# sourceMappingURL=session-history-coordination.js.map