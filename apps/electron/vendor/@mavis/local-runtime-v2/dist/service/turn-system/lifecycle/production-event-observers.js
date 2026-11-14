export function combineAgentEventObservers(...observers) {
    const active = observers.filter((observer) => observer !== undefined);
    if (active.length === 0)
        return undefined;
    if (active.length === 1)
        return active[0];
    return {
        observeRuntimeEvent: (input) => observeAll(active, (observer) => observer.observeRuntimeEvent?.(input)),
        observeHistoryCommitted: (input) => observeAll(active, (observer) => observer.observeHistoryCommitted?.(input)),
        observeHistoryFailure: (input) => observeAll(active, (observer) => observer.observeHistoryFailure?.(input)),
    };
}
/** Projects transient provider retry state from Turn execution onto the product event stream. */
export function createSessionLLMRetryEventObserver(publish) {
    return (event) => {
        // Only foreground/compaction retries belong to the Session retry UI wire contract.
        if (event.scope !== 'agent' && event.scope !== 'compaction')
            return;
        publish({
            type: 'session.llm_retry',
            payload: { schemaVersion: 1, ...event, scope: event.scope },
        });
    };
}
/** 把运行器的慢送审通知投到产品事件流，界面据此在输入框上方提示检查电脑负荷。 */
export function createContentReviewSlowEventObserver(publish) {
    return ({ sessionId, turnId, cleared }) => publish({
        type: 'content.review.slow',
        payload: { sessionId, turnId, ...(cleared ? { cleared: true } : {}) },
    });
}
async function observeAll(observers, observe) {
    const results = await Promise.allSettled(observers.map((observer) => observe(observer)));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length === 1)
        throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(failures, 'Agent event observers failed');
}
//# sourceMappingURL=production-event-observers.js.map