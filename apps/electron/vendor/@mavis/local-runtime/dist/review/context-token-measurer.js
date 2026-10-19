import { messagesContainImageData } from '../context/image-detection.js';
import { estimateMessagesTokens, estimateSystemPromptAndToolTokens, } from '../context/token-estimator.js';
const REMOTE_COUNT_SKIP_RATIO = 0.5;
export function estimateReviewInputTokensLocally(input) {
    const tokens = estimateMessagesTokens(input.messages, { model: input.model }) +
        estimateSystemPromptAndToolTokens(input.systemPrompt, input.tools);
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
        throw new Error('Review input token estimate is invalid');
    }
    return {
        tokens,
        localTokens: tokens,
        source: 'local_estimate',
        messageCount: input.messages.length,
    };
}
export async function measureReviewInputTokens(input, inputBudgetTokens, remoteCounter) {
    const local = estimateReviewInputTokensLocally(input);
    if (!remoteCounter || !supportsRemoteTokenCounter(input.model.api))
        return local;
    const hasImages = messagesContainImageData(input.messages);
    if (inputBudgetTokens > 0 &&
        local.tokens < inputBudgetTokens * REMOTE_COUNT_SKIP_RATIO &&
        !hasImages) {
        return local;
    }
    try {
        const counted = await remoteCounter.countContextTokens({
            messages: input.messages,
            model: input.model,
            ...(input.apiKey ? { apiKey: input.apiKey } : {}),
            ...(input.headers ? { headers: input.headers } : {}),
            ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
            ...(input.tools ? { tools: input.tools } : {}),
            ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
            ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
            thinkingLevel: input.thinkingLevel,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (counted.source === 'remote' && Number.isSafeInteger(counted.tokens) && counted.tokens > 0) {
            return {
                tokens: counted.tokens,
                localTokens: local.localTokens,
                source: 'remote_count_tokens',
                messageCount: input.messages.length,
            };
        }
        const tokens = Number.isSafeInteger(counted.tokens) && counted.tokens >= 0
            ? Math.max(local.tokens, counted.tokens)
            : local.tokens;
        return {
            tokens,
            localTokens: local.localTokens,
            source: 'fallback_estimate',
            messageCount: input.messages.length,
        };
    }
    catch {
        return {
            ...local,
            source: 'fallback_estimate',
        };
    }
}
function supportsRemoteTokenCounter(api) {
    return api === 'anthropic-messages' || api === 'openai-completions' || api === 'openai-responses';
}
//# sourceMappingURL=context-token-measurer.js.map