const observations = new Set();
export function observeModelAccessWork(work) {
    const observation = { settled: Promise.resolve() };
    observation.settled = (async () => {
        try {
            await work;
        }
        catch {
            // Owners retain and report operation failures; detached cleanup must not reject globally.
        }
        finally {
            observations.delete(observation);
        }
    })();
    observations.add(observation);
}
/** Run `work`, waiting for it at most `timeoutMs`; a slower `work` keeps running unobserved. */
export async function settleWithin(work, timeoutMs) {
    let timer;
    try {
        await Promise.race([
            work(),
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
/** Resolves once `promise` settles, never rejecting: keeps a serialization lane open after failure. */
export async function settleQuietly(promise) {
    try {
        await promise;
    }
    catch {
        /* The lane's caller observes the failure itself. */
    }
}
//# sourceMappingURL=settlement.js.map