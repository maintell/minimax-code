export function parseTopLevelInputTokens(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const inputTokens = payload.input_tokens;
    return typeof inputTokens === 'number' ? inputTokens : undefined;
}
export function parseUsageTotalTokens(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const usage = payload.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage))
        return undefined;
    const totalTokens = usage.total_tokens;
    return typeof totalTokens === 'number' ? totalTokens : undefined;
}
export function parseDataTotalTokens(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        return undefined;
    const data = payload.data;
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return undefined;
    const totalTokens = data.total_tokens;
    return typeof totalTokens === 'number' ? totalTokens : undefined;
}
//# sourceMappingURL=parse.js.map