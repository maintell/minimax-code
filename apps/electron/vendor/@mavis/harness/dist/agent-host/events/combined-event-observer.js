/** One observer that fans every Agent event out to the defined ones; failures are aggregated. */
export function combineAgentEventObservers(...observers) {
    const active = observers.filter((observer) => observer !== undefined);
    if (active.length === 0)
        return undefined;
    if (active.length === 1)
        return active[0];
    return {
        observesTurnContent: async (sessionId) => (await Promise.all(active.map((observer) => observer.observesTurnContent?.(sessionId)))).some(Boolean),
        observeRuntimeEvent: (input) => observeAll(active, (observer) => observer.observeRuntimeEvent?.(input)),
        observeHistoryCommitted: (input) => observeAll(active, (observer) => observer.observeHistoryCommitted?.(input)),
        observeHistoryFailure: (input) => observeAll(active, (observer) => observer.observeHistoryFailure?.(input)),
    };
}
async function observeAll(observers, observe) {
    const results = await Promise.allSettled(observers.map((observer) => observe(observer)));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, 'Agent event observers failed');
}
//# sourceMappingURL=combined-event-observer.js.map