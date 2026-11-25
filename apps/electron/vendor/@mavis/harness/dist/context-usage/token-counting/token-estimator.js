import { createDefaultTokenEstimator, } from '@mavis/context-manager';
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '[unserializable]';
    }
}
export function estimateMessagesTokens(messages, _options = {}) {
    return createDefaultTokenEstimator().estimateMessages([...messages]);
}
/**
 * Estimate of the provider-payload parts that live OUTSIDE the message list:
 * the composed system prompt and the active tool declarations. The message
 * usage/text estimators alone systematically under-count the real payload —
 * a large system prompt plus an MCP-heavy tool registry easily adds tens of
 * thousands of tokens — so trigger gates comparing against the real context
 * window must include this footprint.
 */
export function estimateSystemPromptAndToolTokens(systemPrompt, tools) {
    const syntheticMessages = [];
    if (systemPrompt) {
        syntheticMessages.push(textEstimateMessage(systemPrompt));
    }
    for (const tool of tools ?? []) {
        syntheticMessages.push(textEstimateMessage([tool.name ?? '', tool.description ?? '', safeJsonStringify(tool.parameters)].join('\n')));
    }
    return syntheticMessages.length > 0 ? estimateMessagesTokens(syntheticMessages) : 0;
}
function textEstimateMessage(text) {
    return {
        role: 'user',
        content: [{ type: 'text', text }],
        timestamp: 0,
    };
}
//# sourceMappingURL=token-estimator.js.map