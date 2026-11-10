import { TitleGenerationBudget } from './title-generation-budget.js';
export class TitleModelCompletionError extends Error {
    name = 'TitleModelCompletionError';
}
export async function completeTitleModel(options, input) {
    const result = await completeTitleModelResponse(options, input);
    return result.content
        .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
        .join('')
        .trim();
}
export async function completeTitleModelResponse(options, input) {
    const budget = new TitleGenerationBudget(input.timeoutMs, input.signal ? [input.signal] : [], input.deadlineAt);
    try {
        budget.assertActive();
        const agentConfig = await options.buildAgentConfig(input.session);
        budget.assertActive();
        const resolved = await options.resolveModel({
            sessionId: input.session.sessionId,
            turnId: input.turnId,
            agentConfig,
        });
        budget.assertActive();
        const response = await (resolved.stream ?? options.stream)(resolved.model, {
            systemPrompt: input.systemPrompt,
            messages: [{ role: 'user', content: input.userPrompt, timestamp: options.nowMs() }],
            ...(input.tools ? { tools: input.tools } : {}),
        }, {
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.headers ? { headers: resolved.headers } : {}),
            fetch: resolved.fetch,
            ...(resolved.thinkingLevel && resolved.thinkingLevel !== 'off'
                ? { reasoning: resolved.thinkingLevel }
                : {}),
            maxTokens: input.maxTokens,
            timeoutMs: budget.remainingMs,
            signal: budget.signal,
        });
        const result = await response.result();
        budget.assertActive();
        if (['error', 'aborted'].includes(result.stopReason)) {
            throw new TitleModelCompletionError(result.errorMessage ?? `title LLM ${result.stopReason}`);
        }
        return result;
    }
    finally {
        budget.dispose();
    }
}
//# sourceMappingURL=title-model-completion.js.map