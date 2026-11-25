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
//# sourceMappingURL=production-event-observers.js.map