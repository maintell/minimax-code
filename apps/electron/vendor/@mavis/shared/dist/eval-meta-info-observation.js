/**
 * Phase timing for automatic meta-info collection.
 *
 * Observations carry only the fixed numeric/enum fields of `CollectionObservation`: no path,
 * command name, environment value or error text ever reaches a listener. Listeners are
 * best-effort — a throwing listener is swallowed so observation can never change or fail the
 * collection it is watching. With no listener the recorder is a no-op and does not even read
 * the clock.
 */
const NOOP_TIMER = { finish: () => { } };
const NOOP_OBSERVER = { start: () => NOOP_TIMER };
export function createCollectionObserver(listener) {
    if (!listener)
        return NOOP_OBSERVER;
    return {
        start(phase, options) {
            const startedAtMs = performance.now();
            const trackProcess = options?.trackProcess === true;
            const startedCpuMicros = trackProcess ? readCpuMicros() : undefined;
            const startedRssBytes = trackProcess ? readRssBytes() : undefined;
            let finished = false;
            return {
                finish(result) {
                    if (finished)
                        return;
                    finished = true;
                    const endedCpuMicros = startedCpuMicros === undefined ? undefined : readCpuMicros();
                    const endedRssBytes = startedRssBytes === undefined ? undefined : readRssBytes();
                    const event = {
                        phase,
                        outcome: result.outcome,
                        durationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
                        ...(startedCpuMicros !== undefined && endedCpuMicros !== undefined
                            ? { cpuTimeMs: Math.max(0, Math.round((endedCpuMicros - startedCpuMicros) / 1000)) }
                            : {}),
                        ...(startedRssBytes !== undefined && endedRssBytes !== undefined
                            ? { rssDeltaBytes: Math.round(endedRssBytes - startedRssBytes) }
                            : {}),
                        ...countField('rawCount', result.rawCount),
                        ...countField('filteredCount', result.filteredCount),
                        ...countField('retainedCount', result.retainedCount),
                        ...countField('outputBytes', result.outputBytes),
                        ...(result.truncated === undefined ? {} : { truncated: result.truncated }),
                        ...(result.scanComplete === undefined ? {} : { scanComplete: result.scanComplete }),
                        ...(result.reason === undefined ? {} : { reason: result.reason }),
                    };
                    try {
                        listener(event);
                    }
                    catch {
                        // An observer that throws must not change what was collected.
                    }
                },
            };
        },
    };
}
function countField(name, value) {
    if (value === undefined || !Number.isFinite(value))
        return {};
    return { [name]: Math.max(0, Math.round(value)) };
}
function readCpuMicros() {
    try {
        const usage = process.cpuUsage();
        return usage.user + usage.system;
    }
    catch {
        return undefined;
    }
}
function readRssBytes() {
    try {
        return typeof process.memoryUsage.rss === 'function'
            ? process.memoryUsage.rss()
            : process.memoryUsage().rss;
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=eval-meta-info-observation.js.map