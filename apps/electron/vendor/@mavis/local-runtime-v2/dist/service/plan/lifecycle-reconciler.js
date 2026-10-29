export function createPlanLifecycleReconciler(options) {
    const pendingRequestIds = new Set();
    const pendingQueueWakeSessionIds = new Set();
    let recoveryRequested = false;
    let stopped = false;
    let running;
    let consecutiveFailures = 0;
    const retryDelay = options.retryDelay ??
        ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    const hasPendingWork = () => recoveryRequested || pendingQueueWakeSessionIds.size > 0;
    const drain = async () => {
        while (hasPendingWork() && !stopped) {
            const shouldRecover = recoveryRequested;
            const queueWakeSessionIds = [...pendingQueueWakeSessionIds];
            recoveryRequested = false;
            pendingQueueWakeSessionIds.clear();
            if (shouldRecover)
                pendingRequestIds.clear();
            let failed = false;
            if (shouldRecover) {
                try {
                    await options.recover(true);
                }
                catch (error) {
                    options.reportFailure(error);
                    recoveryRequested = true;
                    failed = true;
                }
            }
            for (const sessionId of queueWakeSessionIds) {
                try {
                    await options.dispatchQueue(sessionId);
                }
                catch (error) {
                    options.reportFailure(error);
                    pendingQueueWakeSessionIds.add(sessionId);
                    failed = true;
                }
            }
            if (failed) {
                consecutiveFailures += 1;
                if (!stopped) {
                    const delayMs = Math.min(250 * 2 ** (consecutiveFailures - 1), 5_000);
                    await retryDelay(delayMs);
                }
            }
            else {
                consecutiveFailures = 0;
            }
        }
    };
    const runDrain = async () => {
        // Defer the first pass so failures scheduled in the same event-loop turn
        // coalesce into one level-triggered recovery.
        await Promise.resolve();
        try {
            await drain();
        }
        finally {
            running = undefined;
            if (hasPendingWork() && !stopped)
                running = runDrain();
        }
    };
    return {
        recoverStartup: async (signal) => {
            try {
                return await (signal ? options.recover(true, signal) : options.recover(true));
            }
            catch (error) {
                options.reportFailure(error);
                throw error;
            }
        },
        schedule: (requestId) => {
            if (stopped)
                return;
            pendingRequestIds.add(requestId);
            recoveryRequested = true;
            running ??= runDrain();
        },
        scheduleQueueWake: (sessionId) => {
            if (stopped)
                return;
            pendingQueueWakeSessionIds.add(sessionId);
            running ??= runDrain();
        },
        whenIdle: async () => {
            while (running)
                await running;
        },
        close: async () => {
            stopped = true;
            recoveryRequested = false;
            pendingRequestIds.clear();
            pendingQueueWakeSessionIds.clear();
            while (running)
                await running;
        },
    };
}
//# sourceMappingURL=lifecycle-reconciler.js.map