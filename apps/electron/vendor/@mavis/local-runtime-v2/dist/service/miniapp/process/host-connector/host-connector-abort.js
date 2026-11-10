/** Settles with `operation`, or rejects with the abort reason as soon as `signal` aborts. */
export async function raceWithSignal(operation, signal) {
    if (signal.aborted)
        return Promise.reject(signal.reason);
    let rejectOnAbort = () => undefined;
    const aborted = new Promise((_resolve, reject) => {
        rejectOnAbort = reject;
    });
    const onAbort = () => rejectOnAbort(signal.reason);
    try {
        signal.addEventListener('abort', onAbort, { once: true });
        return await Promise.race([operation, aborted]);
    }
    finally {
        signal.removeEventListener('abort', onAbort);
    }
}
//# sourceMappingURL=host-connector-abort.js.map