/**
 * Outcome, duration, saved-ratio, HMID-recovery and Provider-token metrics of
 * every compaction attempt. A completed attempt is counted only after the
 * Host's lifecycle accepted the committed history; failed, aborted and
 * unchanged attempts are counted from their terminal observation. Recording
 * is best-effort and never changes a compaction outcome.
 */
export class CompactionMetrics {
    started = new Map();
    /** The Host's effects with metric recording; returned unchanged without a metrics client. */
    wrap(effects, client, nowMs) {
        if (!client)
            return effects;
        const metrics = bestEffortMetrics(client);
        const { lifecycle, observer } = effects;
        return {
            lifecycle: {
                completeCommittedHistory: async (input) => {
                    await lifecycle.completeCommittedHistory(input);
                    bestEffort(() => {
                        const started = this.started.get(input.attemptId);
                        recordCompleted(metrics, input.metadata, started && nowMs() - started.startedAtMs);
                    });
                },
                failCommittedHistory: (input) => lifecycle.failCommittedHistory(input),
            },
            observer: {
                observe: (input) => {
                    bestEffort(() => this.track(metrics, input, nowMs));
                    return observer?.observe(input);
                },
            },
        };
    }
    track(metrics, input, nowMs) {
        if (input.status === 'started') {
            if (this.started.has(input.attemptId))
                return;
            this.started.set(input.attemptId, {
                startedAtMs: nowMs(),
                trigger: input.reason === 'automatic' ? 'auto' : 'manual',
            });
            return;
        }
        const started = this.started.get(input.attemptId);
        this.started.delete(input.attemptId);
        // A completed attempt was counted when the Host's lifecycle accepted it.
        if (input.status === 'completed')
            return;
        recordTerminal(metrics, input, started, nowMs());
    }
}
function recordCompleted(metrics, metadata, durationMs) {
    const { method } = metadata;
    const trigger = metadata.phase === 'manual' ? 'manual' : 'auto';
    metrics.counter('compact_outcome_total', 1, { trigger, outcome: 'completed', method });
    if (metadata.hmidOverflowRecovered === true) {
        metrics.counter('compact_hmid_overflow_recovery_total', 1, { trigger });
    }
    if (durationMs !== undefined)
        metrics.histogram('compact_duration_ms', durationMs, { trigger });
    const ratios = [
        ['tokens', metadata.tokensBefore, metadata.tokensAfter],
        ['serialized_bytes', metadata.serializedBytesBefore, metadata.serializedBytesAfter],
    ];
    for (const [dimension, before, after] of ratios) {
        if (before > 0) {
            metrics.histogram('compact_saved_ratio', 1 - after / before, { trigger, method, dimension });
        }
    }
    recordTokenUsage(metrics, metadata.tokenUsage, { trigger, outcome: 'completed' });
}
function recordTerminal(metrics, input, started, terminalAtMs) {
    const unchanged = input.status === 'unchanged';
    const trigger = started?.trigger ?? (unchanged ? 'auto' : 'unknown');
    const outcome = terminalOutcome(input);
    metrics.counter('compact_outcome_total', 1, { trigger, outcome, method: 'none' });
    if (started) {
        metrics.histogram('compact_duration_ms', terminalAtMs - started.startedAtMs, { trigger });
    }
    if (input.status !== 'unchanged') {
        recordTokenUsage(metrics, input.tokenUsage, { trigger, outcome });
    }
}
function terminalOutcome(input) {
    if (input.status !== 'unchanged')
        return input.status;
    return input.reason === 'internal-context-filter' ? 'filter_only' : 'below_trigger';
}
function recordTokenUsage(metrics, tokenUsage, labels) {
    if (!tokenUsage)
        return;
    const kinds = [
        ['input', tokenUsage.inputTokens],
        ['output', tokenUsage.outputTokens],
        ['cache_read', tokenUsage.cacheReadTokens],
        ['cache_write', tokenUsage.cacheWriteTokens],
    ];
    for (const [kind, value] of kinds) {
        metrics.counter('compact_provider_tokens_total', value, { ...labels, kind });
    }
    if (tokenUsage.incomplete) {
        metrics.counter('compact_provider_token_usage_incomplete_total', 1, labels);
    }
}
/** Each metric call is isolated: one failing call does not drop the others. */
function bestEffortMetrics(client) {
    return {
        counter: (name, value, labels) => bestEffort(() => client.counter(name, value, labels)),
        histogram: (name, value, labels) => bestEffort(() => client.histogram(name, value, labels)),
    };
}
function bestEffort(record) {
    try {
        record();
    }
    catch {
        // Metrics never change a compaction outcome.
    }
}
//# sourceMappingURL=compaction-metrics.js.map