import { createDefaultTokenEstimator } from './token-estimator.js';
const tokenEstimator = createDefaultTokenEstimator();
export function estimatePreparedContextUsage(input) {
    const systemPrompt = input.systemPrompt;
    const toolsTokens = estimateTextTokens(safeJsonStringify(input.tools));
    const messagesTokens = normalizeTokenCount(input.messagesTokens);
    if (!validPromptRanges(systemPrompt, input.promptRanges)) {
        return {
            valid: false,
            usedTokens: estimateTextTokens(systemPrompt) + toolsTokens + messagesTokens,
            components: [],
        };
    }
    let cursor = 0;
    let plainSystemTokens = 0;
    let memoryTokens = 0;
    let skillsTokens = 0;
    let otherTokens = 0;
    for (const range of input.promptRanges) {
        plainSystemTokens += estimateTextTokens(systemPrompt.slice(cursor, range.startOffset));
        const rangeTokens = estimateTextTokens(systemPrompt.slice(range.startOffset, range.endOffset));
        if (range.kind === 'MEMORY')
            memoryTokens += rangeTokens;
        else if (range.kind === 'SKILLS')
            skillsTokens += rangeTokens;
        else
            otherTokens += rangeTokens;
        cursor = range.endOffset;
    }
    plainSystemTokens += estimateTextTokens(systemPrompt.slice(cursor));
    const components = [
        { kind: 'SYSTEM_PROMPT', tokens: plainSystemTokens },
        { kind: 'MEMORY', tokens: memoryTokens },
        { kind: 'TOOLS', tokens: toolsTokens },
        { kind: 'SKILLS', tokens: skillsTokens },
        { kind: 'MESSAGES', tokens: messagesTokens },
        { kind: 'OTHER', tokens: otherTokens },
    ];
    return {
        valid: true,
        usedTokens: components.reduce((sum, component) => sum + component.tokens, 0),
        components,
    };
}
/** Reads the context-window aliases used by supported model configurations. */
export function readContextWindowTokens(model) {
    if (!model || typeof model !== 'object')
        return undefined;
    for (const key of ['contextWindow', 'context_window', 'contextWindowTokens']) {
        const value = Reflect.get(model, key);
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return Math.max(1, Math.round(value));
        }
    }
    return undefined;
}
function validPromptRanges(systemPrompt, ranges) {
    let cursor = 0;
    return ranges.every((range) => {
        if (!Number.isSafeInteger(range.startOffset) ||
            !Number.isSafeInteger(range.endOffset) ||
            range.startOffset < cursor ||
            range.endOffset <= range.startOffset ||
            range.endOffset > systemPrompt.length) {
            return false;
        }
        cursor = range.endOffset;
        return true;
    });
}
function estimateTextTokens(text) {
    if (!text)
        return 0;
    return tokenEstimator.estimateMessage({
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: 0,
    });
}
function normalizeTokenCount(value) {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '[unserializable]';
    }
}
//# sourceMappingURL=context-usage-estimator.js.map