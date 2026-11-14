/**
 * Foreground budget of a main conversation on the segment context profile (spec 7.2), in
 * tokens. Pure so the Desktop settings and the runtime compute the same segment growth room G.
 */
/** Share of S and absolute cap for the rebuilt content B (handoff header + kept text). */
const SEGMENT_REBUILD_SOFT_LINE_RATIO = 0.2;
export const SEGMENT_REBUILD_BUDGET_CAP_TOKENS = 25_000;
const SEGMENT_SOFT_LINE_WINDOW_RATIO = 0.6;
/** Estimate of layer ① (system prompt and tool definitions) where the real size is unknown. */
export const SEGMENT_SYSTEM_LAYER_ESTIMATE_TOKENS = 20_000;
/** Layer ②: the rendered MEMORY.md is capped at about 2.5k tokens. */
export const SEGMENT_MEMORY_LAYER_TOKENS = 2_500;
/** Below this growth room a model makes a poor coordinator (spec 3.10, 7.4). */
export const COORDINATOR_MIN_GROWTH_TOKENS = 24_000;
export function resolveSegmentContextBudget(input) {
    const window = Math.max(0, input.contextWindow);
    const quarter = Math.floor(window / 4);
    // Same output reserve as the automatic compaction trigger: min(configured output, window / 4).
    const outputReserve = input.maxOutputTokens !== undefined && input.maxOutputTokens > 0
        ? Math.min(input.maxOutputTokens, quarter)
        : quarter;
    const effectiveWindow = window - outputReserve;
    // No absolute cap: S scales with E, and 0.6 E stays below the hard line (about 0.95 E).
    const softLine = Math.floor(SEGMENT_SOFT_LINE_WINDOW_RATIO * effectiveWindow);
    const rebuildBudget = Math.min(Math.floor(SEGMENT_REBUILD_SOFT_LINE_RATIO * softLine), SEGMENT_REBUILD_BUDGET_CAP_TOKENS);
    const segmentGrowth = softLine -
        (input.systemTokens ?? SEGMENT_SYSTEM_LAYER_ESTIMATE_TOKENS) -
        (input.memoryTokens ?? SEGMENT_MEMORY_LAYER_TOKENS) -
        rebuildBudget;
    return { effectiveWindow, softLine, rebuildBudget, segmentGrowth };
}
/** True when the model's growth room G is below 24k: suitable only with a warning. */
export function isWeakCoordinatorModel(input) {
    return resolveSegmentContextBudget(input).segmentGrowth < COORDINATOR_MIN_GROWTH_TOKENS;
}
//# sourceMappingURL=segment-context-budget.js.map