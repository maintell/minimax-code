export const TOOL_RESULT_COMPACTION_DEFAULTS = {
    enabled: true,
    maxInlineKiB: 64,
    mcpDetailsMaxInlineKiB: 32,
    watermarkKiB: 256,
    minSavingsKiB: 256,
    minCandidateKiB: 2,
    keepRecentRounds: 5,
};
const MAX_SAFE_KIB = Math.floor(Number.MAX_SAFE_INTEGER / 1_024);
/** Resolves the user-facing config.yaml block without allowing unsafe byte conversion. */
export function parseToolResultCompactionConfig(raw) {
    const value = isRecord(raw) ? raw : {};
    return {
        enabled: typeof value.enabled === 'boolean' ? value.enabled : TOOL_RESULT_COMPACTION_DEFAULTS.enabled,
        maxInlineKiB: positiveSafeKiB(value.maxInlineKiB, TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB),
        mcpDetailsMaxInlineKiB: positiveSafeKiB(value.mcpDetailsMaxInlineKiB, TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB),
        watermarkKiB: positiveSafeKiB(value.watermarkKiB, TOOL_RESULT_COMPACTION_DEFAULTS.watermarkKiB),
        minSavingsKiB: positiveSafeKiB(value.minSavingsKiB, TOOL_RESULT_COMPACTION_DEFAULTS.minSavingsKiB),
        minCandidateKiB: positiveSafeKiB(value.minCandidateKiB, TOOL_RESULT_COMPACTION_DEFAULTS.minCandidateKiB),
        keepRecentRounds: positiveSafeInteger(value.keepRecentRounds, TOOL_RESULT_COMPACTION_DEFAULTS.keepRecentRounds),
    };
}
function positiveSafeKiB(value, fallback) {
    return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= MAX_SAFE_KIB
        ? value
        : fallback;
}
function positiveSafeInteger(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=tool-result-compaction-config.js.map