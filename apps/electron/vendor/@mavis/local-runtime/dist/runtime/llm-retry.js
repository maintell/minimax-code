import { recordPiLLMCallMetrics, withLLMRetry, } from '@mavis/agent-core/pi-turn-runner';
import { SESSION_LLM_RETRY_EVENT_TYPE, } from '@mavis/shared/llm-retry-event';
export function withLocalLLMRetry(inner, options) {
    const metricsClient = options.metricsClient;
    return withLLMRetry(inner, {
        sessionId: options.sessionId,
        turnId: options.turnId,
        scope: options.scope,
        observer: createLocalLLMRetryObserver(options),
        ...(metricsClient
            ? {
                onCallSettled: (event) => {
                    recordPiLLMCallMetrics(metricsClient, directLLMCaller(options.scope), event);
                },
            }
            : {}),
    });
}
export function createLocalLLMRetryObserver(options) {
    return (event) => {
        observeRetryMetrics(options.metricsClient, event);
        if (options.exposeToUi === false || event.scope === 'title')
            return;
        options.emitBusEvent?.(SESSION_LLM_RETRY_EVENT_TYPE, {
            ...toSessionLLMRetryEventPayload(event),
        });
    };
}
export function toSessionLLMRetryEventPayload(event) {
    return { schemaVersion: 1, ...event };
}
function observeRetryMetrics(client, event) {
    const reason = event.error?.reason;
    if (!client || !reason)
        return;
    const labels = { reason, scope: event.scope };
    try {
        if (event.status === 'waiting') {
            client.counter('pi_llm_retry_total', 1, labels);
            if (event.delayMs !== undefined) {
                client.histogram('pi_llm_retry_delay_ms', event.delayMs, labels);
            }
        }
        else if (event.status === 'exhausted') {
            client.counter('pi_llm_retry_exhausted_total', 1, labels);
        }
    }
    catch {
        // Retry observability must never change provider-call behavior.
    }
}
function directLLMCaller(scope) {
    if (scope === 'title')
        return 'title';
    if (scope === 'compaction')
        return 'compact';
    return 'unknown';
}
//# sourceMappingURL=llm-retry.js.map