export function validateUsageInsert(row) {
    const values = [
        row.ts,
        row.inputTokens,
        row.outputTokens,
        row.reasoningTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens,
    ];
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        throw new TypeError('Usage values must be non-negative safe integers');
    }
}
//# sourceMappingURL=policy.js.map