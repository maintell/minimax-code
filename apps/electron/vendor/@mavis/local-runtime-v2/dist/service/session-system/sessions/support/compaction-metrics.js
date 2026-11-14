import { isCommittedCompactionMethod } from './tool-call-mode.js';
export function recordCompletedCompactionMetrics(options, input, started) {
    const metrics = options.compactionMetrics;
    const metadata = readCompactionMetricMetadata(input.metadata);
    if (!metrics || !metadata)
        return;
    const { phase, method, tokensBefore, tokensAfter, bytesBefore, bytesAfter, hmidOverflowRecovered, tokenUsage, } = metadata;
    const trigger = phase === 'manual' ? 'manual' : 'auto';
    try {
        metrics.counter('compact_outcome_total', 1, { trigger, outcome: 'completed', method });
        if (hmidOverflowRecovered) {
            metrics.counter('compact_hmid_overflow_recovery_total', 1, { trigger });
        }
        if (started) {
            metrics.histogram('compact_duration_ms', (options.nowMs ?? Date.now)() - started.startedAtMs, {
                trigger,
            });
        }
        const ratioLabels = { trigger, method };
        if (tokensBefore > 0) {
            metrics.histogram('compact_saved_ratio', 1 - tokensAfter / tokensBefore, {
                ...ratioLabels,
                dimension: 'tokens',
            });
        }
        if (bytesBefore > 0) {
            metrics.histogram('compact_saved_ratio', 1 - bytesAfter / bytesBefore, {
                ...ratioLabels,
                dimension: 'serialized_bytes',
            });
        }
        recordCompactionTokenUsage(metrics, tokenUsage, { trigger, outcome: 'completed' });
    }
    catch {
        // Metrics must never change projection or Host outcomes.
    }
}
export function recordTerminalCompactionMetrics(options, input, started, terminalAtMs) {
    const metrics = options.compactionMetrics;
    if (!metrics)
        return;
    const trigger = started?.trigger ?? fallbackCompactionTrigger(input);
    const outcome = terminalCompactionOutcome(input);
    try {
        metrics.counter('compact_outcome_total', 1, { trigger, outcome, method: 'none' });
        if (started) {
            metrics.histogram('compact_duration_ms', terminalAtMs - started.startedAtMs, { trigger });
        }
        recordCompactionTokenUsage(metrics, terminalCompactionTokenUsage(input), { trigger, outcome });
    }
    catch {
        // Metrics must never change projection or Host outcomes.
    }
}
function fallbackCompactionTrigger(input) {
    return input.status === 'unchanged' ? 'auto' : 'unknown';
}
function terminalCompactionOutcome(input) {
    if (input.status !== 'unchanged')
        return input.status;
    return input.reason === 'internal-context-filter' ? 'filter_only' : 'below_trigger';
}
export function readCompactionMethod(value) {
    if (!isRecord(value))
        return undefined;
    return isCommittedCompactionMethod(value.method) ? value.method : undefined;
}
function readCompactionMetricMetadata(value) {
    if (!isRecord(value))
        return undefined;
    const phase = value.phase;
    if (phase !== 'initial' && phase !== 'iteration' && phase !== 'manual')
        return undefined;
    const method = readCompactionMethod(value);
    if (!method)
        return undefined;
    const counts = readCompactionMetricCounts(value);
    const tokenUsage = readCompactionTokenUsage(value.tokenUsage);
    return counts
        ? {
            phase,
            method,
            ...counts,
            ...compactionTokenUsageMetadata(tokenUsage),
            hmidOverflowRecovered: Reflect.get(value, 'hmidOverflowRecovered') === true,
        }
        : undefined;
}
export function compactionTokenUsageMetadata(tokenUsage) {
    if (tokenUsage === undefined)
        return {};
    return { tokenUsage };
}
function terminalCompactionTokenUsage(input) {
    if (input.status === 'unchanged')
        return undefined;
    return input.tokenUsage;
}
export function terminalCompactionTokenUsageMetadata(input) {
    return compactionTokenUsageMetadata(terminalCompactionTokenUsage(input));
}
function recordCompactionTokenUsage(metrics, tokenUsage, labels) {
    if (!metrics || !tokenUsage)
        return;
    for (const [kind, value] of [
        ['input', tokenUsage.inputTokens],
        ['output', tokenUsage.outputTokens],
        ['cache_read', tokenUsage.cacheReadTokens],
        ['cache_write', tokenUsage.cacheWriteTokens],
    ]) {
        try {
            metrics.counter('compact_provider_tokens_total', value, { ...labels, kind });
        }
        catch {
            // Metrics must never change projection or Host outcomes.
        }
    }
    if (tokenUsage.incomplete) {
        try {
            metrics.counter('compact_provider_token_usage_incomplete_total', 1, labels);
        }
        catch {
            // Metrics must never change projection or Host outcomes.
        }
    }
}
function readCompactionTokenUsage(value) {
    if (!isRecord(value))
        return undefined;
    const inputTokens = readNonNegativeNumber(value.inputTokens);
    const outputTokens = readNonNegativeNumber(value.outputTokens);
    const cacheReadTokens = readNonNegativeNumber(value.cacheReadTokens);
    const cacheWriteTokens = readNonNegativeNumber(value.cacheWriteTokens);
    const totalTokens = readNonNegativeNumber(value.totalTokens);
    if (inputTokens === undefined ||
        outputTokens === undefined ||
        cacheReadTokens === undefined ||
        cacheWriteTokens === undefined ||
        totalTokens === undefined ||
        typeof value.incomplete !== 'boolean' ||
        totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) {
        return undefined;
    }
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        incomplete: value.incomplete,
    };
}
function readCompactionMetricCounts(value) {
    const tokensBefore = readNonNegativeNumber(value.tokensBefore);
    const tokensAfter = readNonNegativeNumber(value.tokensAfter);
    const bytesBefore = readNonNegativeNumber(value.serializedBytesBefore);
    const bytesAfter = readNonNegativeNumber(value.serializedBytesAfter);
    if (tokensBefore === undefined)
        return undefined;
    if (tokensAfter === undefined)
        return undefined;
    if (bytesBefore === undefined)
        return undefined;
    if (bytesAfter === undefined)
        return undefined;
    return { tokensBefore, tokensAfter, bytesBefore, bytesAfter };
}
function readNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=compaction-metrics.js.map