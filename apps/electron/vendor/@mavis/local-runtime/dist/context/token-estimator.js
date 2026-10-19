import { calculateContextTokens } from '@earendil-works/pi-coding-agent/compaction';
import { computeCompactionTriggerAt as computeSharedCompactionTriggerAt, createDefaultTokenEstimator, } from '@mavis/context-manager';
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '[unserializable]';
    }
}
export function estimateMessagesTokens(messages, _options = {}) {
    return createDefaultTokenEstimator().estimateMessages([...messages]);
}
/**
 * Estimate of the provider-payload parts that live OUTSIDE the message list:
 * the composed system prompt and the active tool declarations. The message
 * usage/text estimators alone systematically under-count the real payload —
 * a large system prompt plus an MCP-heavy tool registry easily adds tens of
 * thousands of tokens — so trigger gates comparing against the real context
 * window must include this footprint.
 */
export function estimateSystemPromptAndToolTokens(systemPrompt, tools) {
    const syntheticMessages = [];
    if (systemPrompt) {
        syntheticMessages.push(textEstimateMessage(systemPrompt));
    }
    for (const tool of tools ?? []) {
        syntheticMessages.push(textEstimateMessage([tool.name ?? '', tool.description ?? '', safeJsonStringify(tool.parameters)].join('\n')));
    }
    return syntheticMessages.length > 0 ? estimateMessagesTokens(syntheticMessages) : 0;
}
function textEstimateMessage(text) {
    return {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: 0,
    };
}
export function estimateActiveContextTokens(messages, _options = {}) {
    const compactedAfterMs = readLeadingCompactionSummaryTimestamp(messages);
    const lastUsageIndex = findLastFreshAssistantUsageIndex(messages, compactedAfterMs);
    if (lastUsageIndex < 0) {
        return { tokens: estimateMessagesTokens(messages), usageAnchored: false };
    }
    const usage = readFreshAssistantUsage(messages[lastUsageIndex], compactedAfterMs);
    if (!usage) {
        return { tokens: estimateMessagesTokens(messages), usageAnchored: false };
    }
    const lastEstimate = calculateContextTokens(usage) + estimateMessagesTokens(messages.slice(lastUsageIndex + 1));
    // Floor the estimate at the PEAK fresh-usage context since the last
    // compaction. When usage oscillates (small sub-call turns interleave between
    // large main-thread turns), anchoring purely on the LAST usage lets a small
    // trailing turn deflate the estimate below the trigger line and silently skip
    // compaction. Once any post-compaction turn reported a context over the line,
    // latch the gate to that peak. For a monotonic session peak == last, so this
    // is a no-op there.
    return {
        tokens: Math.max(lastEstimate, maxFreshUsageContextTokens(messages, compactedAfterMs)),
        usageAnchored: true,
    };
}
export function computeCompactionTriggerAt(input) {
    return computeSharedCompactionTriggerAt(input);
}
// Max `calculateContextTokens` over fresh (post-compaction) assistant usages.
// Returns 0 when none qualify.
function maxFreshUsageContextTokens(messages, compactedAfterMs) {
    let peak = 0;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const usage = readFreshAssistantUsage(messages[i], compactedAfterMs);
        if (!usage)
            continue;
        const candidate = calculateContextTokens(usage);
        if (candidate > peak)
            peak = candidate;
    }
    return peak;
}
function findLastFreshAssistantUsageIndex(messages, compactedAfterMs) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (readFreshAssistantUsage(messages[index], compactedAfterMs))
            return index;
    }
    return -1;
}
function readFreshAssistantUsage(message, compactedAfterMs) {
    const assistant = message;
    if (assistant.role !== 'assistant')
        return undefined;
    if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error')
        return undefined;
    const timestamp = readMessageTimestamp(message);
    if (compactedAfterMs !== undefined &&
        (timestamp === undefined || timestamp <= compactedAfterMs)) {
        return undefined;
    }
    return normalizeUsage(assistant.usage);
}
function normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object')
        return undefined;
    const raw = usage;
    const input = readPositiveTokenCount(raw.input) ?? 0;
    const output = readPositiveTokenCount(raw.output) ?? 0;
    const cacheRead = readPositiveTokenCount(raw.cacheRead) ?? 0;
    const cacheWrite = readPositiveTokenCount(raw.cacheWrite) ?? 0;
    const totalTokens = readPositiveTokenCount(raw.totalTokens) ?? 0;
    if (input + output + cacheRead + cacheWrite + totalTokens <= 0)
        return undefined;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}
function readPositiveTokenCount(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
function readLeadingCompactionSummaryTimestamp(messages) {
    const first = messages[0];
    if (!first)
        return undefined;
    const role = first.role;
    // 当前策略：压缩产物是带 `archonCompaction` 标记的合成 user 消息；
    // legacy 历史仍可能以 pi 风格的 `compactionSummary` 消息开头，两者都认。
    const isCompactionArtifact = role === 'compactionSummary' ||
        (role === 'user' &&
            typeof first.archonCompaction?.summary ===
                'string');
    if (!isCompactionArtifact)
        return undefined;
    return readMessageTimestamp(first);
}
function readMessageTimestamp(message) {
    const timestamp = message.timestamp;
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : undefined;
}
//# sourceMappingURL=token-estimator.js.map