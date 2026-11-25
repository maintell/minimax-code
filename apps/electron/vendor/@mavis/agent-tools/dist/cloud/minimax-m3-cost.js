/** Prompt-side tokens above this bill MiniMax-M3 at the long-context rates. */
export const MINIMAX_M3_LONG_CONTEXT_INPUT_TOKENS = 512_000;
// MiniMax-M3 PAYG rates in USD per 1M tokens. The public pricing table has
// no cache-write column, so cache writes use the non-cached input rate.
export const MINIMAX_M3_STANDARD_COST = {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.06,
    cacheWrite: 0.3,
};
export const MINIMAX_M3_LONG_CONTEXT_COST = {
    input: 0.6,
    output: 2.4,
    cacheRead: 0.12,
    cacheWrite: 0.6,
};
export function isMiniMaxM3(provider, modelId) {
    const normalizedProvider = provider.trim().toLowerCase();
    if (normalizedProvider !== 'minimax' &&
        normalizedProvider !== 'minimax-cn' &&
        normalizedProvider !== 'minimax_m3') {
        return false;
    }
    const normalizedModel = modelId.trim().toLowerCase();
    return normalizedModel === 'minimax-m3' || normalizedModel === 'm3';
}
//# sourceMappingURL=minimax-m3-cost.js.map