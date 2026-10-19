/** Goal accounting counts every available fresh provider token, excluding cache counters. */
export function sumCommittedPiUsageTokens(messages) {
    return summarizeCommittedPiGoalUsage(messages).tokens;
}
/** Keep missing provider usage distinct from a trustworthy zero-cost turn. */
export function summarizeCommittedPiGoalUsage(messages) {
    return messages.reduce((summary, message) => {
        if (!isAssistantMessage(message))
            return summary;
        const usage = readAssistantUsage(message);
        if (!usage)
            return { ...summary, incomplete: true };
        const normalized = normalizePiUsage(usage);
        return {
            tokens: summary.tokens +
                normalized.inputTokens +
                normalized.outputTokens +
                normalized.reasoningTokens,
            incomplete: summary.incomplete,
        };
    }, { tokens: 0, incomplete: false });
}
export async function recordCommittedPiUsage(input) {
    let recorded = 0;
    try {
        for (const row of committedPiUsageRows(input)) {
            await input.store.append(row);
            recorded += 1;
        }
    }
    catch (error) {
        reportUsageFailure(input, error);
    }
    return recorded;
}
function committedPiUsageRows(input) {
    return input.messages.flatMap((message) => {
        const usage = readPiUsage(message);
        return usage
            ? [
                {
                    sessionId: input.session.sessionId,
                    agentName: input.session.agentName,
                    frameworkType: 'pi-agent',
                    turnId: input.turnId,
                    model: input.model ?? null,
                    ts: readTimestamp(message) ?? input.nowMs(),
                    ...usage,
                },
            ]
            : [];
    });
}
function reportUsageFailure(input, error) {
    try {
        input.onFailure?.({
            sessionId: input.session.sessionId,
            turnId: input.turnId,
            error,
        });
    }
    catch {
        // Usage is a best-effort projection after the canonical history commit.
    }
}
function readPiUsage(message) {
    const usage = readAssistantUsage(message);
    if (!usage)
        return undefined;
    const normalized = normalizePiUsage(usage);
    if (!hasUsage(normalized))
        return undefined;
    return { ...normalized, costUsd: readCostUsd(usage), raw: safeJson(usage) };
}
function readAssistantUsage(message) {
    if (!isAssistantMessage(message))
        return undefined;
    const rawUsage = Reflect.get(message, 'usage');
    if (!rawUsage || typeof rawUsage !== 'object')
        return undefined;
    return rawUsage;
}
function isAssistantMessage(message) {
    return Boolean(message && typeof message === 'object' && Reflect.get(message, 'role') === 'assistant');
}
function normalizePiUsage(usage) {
    const piInput = numericValue(usage.input);
    const piOutput = numericValue(usage.output);
    const inputTokens = piInput > 0 || piOutput > 0 ? piInput : numericValue(usage.total_tokens);
    const outputTokens = piInput > 0 || piOutput > 0 ? piOutput : 0;
    return {
        inputTokens,
        outputTokens,
        reasoningTokens: numericValue(usage.reasoning),
        cacheReadTokens: numericValue(usage.cacheRead ?? usage.cache?.read ?? usage.cache_read),
        cacheWriteTokens: numericValue(usage.cacheWrite ?? usage.cache?.write ?? usage.cache_write),
    };
}
function hasUsage(usage) {
    return (usage.inputTokens +
        usage.outputTokens +
        usage.reasoningTokens +
        usage.cacheReadTokens +
        usage.cacheWriteTokens !==
        0);
}
function readCostUsd(usage) {
    return typeof usage.cost?.total === 'number' && Number.isFinite(usage.cost.total)
        ? usage.cost.total
        : null;
}
function readTimestamp(message) {
    if (!message || typeof message !== 'object')
        return undefined;
    const value = Reflect.get(message, 'timestamp') ?? Reflect.get(message, 'created_at');
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}
function numericValue(value) {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
}
function safeJson(value) {
    try {
        return JSON.stringify(value) ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=pi-usage.js.map