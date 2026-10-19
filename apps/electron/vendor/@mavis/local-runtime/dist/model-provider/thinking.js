const PI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const MINIMAX_M3_MODEL_ID = 'MiniMax-M3';
// Keep the adaptive-thinking probe at the same minimum usable output floor as
// normal Messages-compatible requests. Smaller caps can finish before MiniMax emits a
// Messages `content` block and make a valid key look like an invalid response.
export const MINIMAX_M3_THINKING_TEST_MAX_TOKENS = 1_024;
export function isMiniMaxM3ModelId(value) {
    return (typeof value === 'string' && value.trim().toLowerCase() === MINIMAX_M3_MODEL_ID.toLowerCase());
}
export function isMiniMaxM3ThinkingMode(value) {
    return value === 'on' || value === 'off';
}
/** MiniMax M3 exposes an on/off control; Responses effort values do not change thinking depth. */
export function resolveMiniMaxM3ThinkingProtocol(api, mode) {
    if (api === 'openai-responses') {
        return { reasoning: { effort: mode === 'on' ? 'minimal' : 'none' } };
    }
    return { thinking: { type: mode === 'on' ? 'adaptive' : 'disabled' } };
}
export function normalizeModelThinkingEffort(value) {
    if (typeof value !== 'string')
        return undefined;
    const effort = value.trim();
    return effort || undefined;
}
export function normalizeModelThinkingEffortOptions(value) {
    if (!Array.isArray(value))
        return undefined;
    const options = [];
    const seen = new Set();
    for (const item of value) {
        const option = normalizeModelThinkingEffort(item);
        if (!option || seen.has(option))
            continue;
        seen.add(option);
        options.push(option);
    }
    return options.length > 0 ? options : undefined;
}
/**
 * Use the higher midpoint for an even-sized ordered list. This keeps a
 * two-choice off/on model enabled until the user makes a session choice.
 */
export function resolveModelThinkingMiddleEffort(effortOptions) {
    if (!effortOptions?.length)
        return undefined;
    return effortOptions[Math.floor(effortOptions.length / 2)];
}
/**
 * Keep the user-defined effort value intact and use only the Provider form's
 * explicit API format to choose its wire location. The internal Pi level is a
 * transport key; thinkingLevelMap maps it back to the exact user value.
 */
export function resolveModelThinkingProtocol(api, value, modelId) {
    const effort = normalizeModelThinkingEffort(value);
    if (!effort)
        return undefined;
    if (isMiniMaxM3ModelId(modelId) && isMiniMaxM3ThinkingMode(effort)) {
        const piLevel = 'high';
        const base = {
            effort,
            enabled: effort === 'on',
            piLevel,
            thinkingLevelMap: { [piLevel]: effort },
            requestPatch: resolveMiniMaxM3ThinkingProtocol(api, effort),
            minimumMaxTokens: effort === 'on' ? MINIMAX_M3_THINKING_TEST_MAX_TOKENS : 1,
        };
        if (api === 'anthropic-messages') {
            return { ...base, forceAdaptiveThinking: true };
        }
        if (api === 'openai-completions') {
            return { ...base, completionsThinkingFormat: 'openai' };
        }
        return base;
    }
    const piLevel = PI_THINKING_LEVELS.has(effort) ? effort : 'high';
    const base = {
        effort,
        piLevel,
        thinkingLevelMap: { [piLevel]: effort },
        minimumMaxTokens: 1,
    };
    if (api === 'anthropic-messages') {
        return {
            ...base,
            forceAdaptiveThinking: true,
            requestPatch: {
                thinking: { type: 'adaptive' },
                output_config: { effort },
            },
        };
    }
    if (api === 'openai-completions') {
        return {
            ...base,
            requestPatch: { reasoning_effort: effort },
            completionsThinkingFormat: 'openai',
        };
    }
    return {
        ...base,
        requestPatch: { reasoning: { effort } },
    };
}
//# sourceMappingURL=thinking.js.map