export function createCompactionTokenUsageAccumulator() {
    let observed = false;
    let incomplete = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const observe = (event) => {
        observed = true;
        incomplete ||= !event.usageComplete;
        if (!event.usage) {
            incomplete = true;
            return;
        }
        const input = readProviderTokenBucket(event.usage.input);
        const output = readProviderTokenBucket(event.usage.output);
        const cacheRead = readProviderTokenBucket(event.usage.cacheRead);
        const cacheWrite = readProviderTokenBucket(event.usage.cacheWrite);
        incomplete ||=
            input === undefined ||
                output === undefined ||
                cacheRead === undefined ||
                cacheWrite === undefined;
        inputTokens = addProviderTokens(inputTokens, input);
        outputTokens = addProviderTokens(outputTokens, output);
        cacheReadTokens = addProviderTokens(cacheReadTokens, cacheRead);
        cacheWriteTokens = addProviderTokens(cacheWriteTokens, cacheWrite);
    };
    return {
        observe,
        snapshot: () => {
            if (!observed)
                return undefined;
            return {
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
                incomplete,
            };
        },
    };
}
export function compactionTokenUsageMetadata(tokenUsage) {
    if (tokenUsage === undefined)
        return {};
    return { tokenUsage };
}
export function readCompactionTokenUsage(value) {
    if (!isRecord(value))
        return undefined;
    const inputTokens = readNonNegativeNumber(Reflect.get(value, 'inputTokens'));
    const outputTokens = readNonNegativeNumber(Reflect.get(value, 'outputTokens'));
    const cacheReadTokens = readNonNegativeNumber(Reflect.get(value, 'cacheReadTokens'));
    const cacheWriteTokens = readNonNegativeNumber(Reflect.get(value, 'cacheWriteTokens'));
    const totalTokens = readNonNegativeNumber(Reflect.get(value, 'totalTokens'));
    const incomplete = Reflect.get(value, 'incomplete');
    if (inputTokens === undefined ||
        outputTokens === undefined ||
        cacheReadTokens === undefined ||
        cacheWriteTokens === undefined ||
        totalTokens === undefined ||
        typeof incomplete !== 'boolean' ||
        totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens) {
        return undefined;
    }
    return {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens,
        incomplete,
    };
}
function readProviderTokenBucket(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function addProviderTokens(current, value) {
    if (value === undefined)
        return current;
    const total = current + value;
    return Number.isFinite(total) ? total : current;
}
function readNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=token-usage.js.map