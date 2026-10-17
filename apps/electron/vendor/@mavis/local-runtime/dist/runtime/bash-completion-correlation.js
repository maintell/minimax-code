const MAX_SESSION_BASH_COMPLETIONS = 2_048;
export const POST_BASH_GAP_HISTOGRAM_BUCKETS = [
    100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
    1_800_000, 3_600_000,
];
/** Host-scoped local Bash-to-LLM metrics; never shared across runtime hosts. */
export class LocalBashCompletionCorrelation {
    metricsClient;
    completions = new Map();
    constructor(metricsClient) {
        this.metricsClient = metricsClient;
    }
    record = (sessionId, completion) => {
        this.completions.delete(sessionId);
        this.completions.set(sessionId, completion);
        if (this.completions.size <= MAX_SESSION_BASH_COMPLETIONS)
            return;
        const oldest = this.completions.keys().next().value;
        if (oldest !== undefined)
            this.completions.delete(oldest);
    };
    observeLLMRequest = (request) => {
        const completion = this.completions.get(request.sessionId);
        this.completions.delete(request.sessionId);
        if (!completion)
            return undefined;
        const labels = {
            provider: request.provider,
            model: request.model,
            caller: request.caller,
        };
        const gapMs = Math.max(0, request.startedAtMs - completion.endedAt);
        try {
            this.metricsClient?.histogram('pi_llm_post_bash_gap_ms', gapMs, labels);
        }
        catch {
            // Observability must not affect the provider request path.
        }
        return ({ cacheOutcome }) => {
            try {
                this.metricsClient?.counter('pi_llm_post_bash_cache_outcome_total', 1, {
                    ...labels,
                    bashDurationClass: classifyBashDuration(completion.durationMs),
                    gapClass: classifyPostBashGap(gapMs),
                    outcome: cacheOutcome,
                });
            }
            catch {
                // Observability must not affect the provider request settlement path.
            }
        };
    };
}
function classifyBashDuration(durationMs) {
    return durationMs < 15_000 ? 'lt_15s' : durationMs < 300_000 ? 'lt_5m' : 'gte_5m';
}
function classifyPostBashGap(gapMs) {
    return gapMs < 300_000 ? 'lt_5m' : 'gte_5m';
}
//# sourceMappingURL=bash-completion-correlation.js.map