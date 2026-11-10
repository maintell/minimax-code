export const TOOL_RESULT_COMPACTION_DEFAULTS = {
    maxInlineKiB: 64,
    mcpDetailsMaxInlineKiB: 32,
};
const MAX_SAFE_KIB = Math.floor(Number.MAX_SAFE_INTEGER / 1_024);
/**
 * Resolves the user-facing config.yaml block without allowing unsafe byte conversion.
 * Unknown keys (including retired cumulative-compaction thresholds) are ignored.
 */
export function parseToolResultCompactionConfig(raw) {
    const value = isRecord(raw) ? raw : {};
    return {
        maxInlineKiB: positiveSafeKiB(value.maxInlineKiB, TOOL_RESULT_COMPACTION_DEFAULTS.maxInlineKiB),
        mcpDetailsMaxInlineKiB: positiveSafeKiB(value.mcpDetailsMaxInlineKiB, TOOL_RESULT_COMPACTION_DEFAULTS.mcpDetailsMaxInlineKiB),
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=tool-result-compaction-config.js.map