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
    const agentConfig = await options.buildAgentConfig(input.session);
    const resolved = await options.resolveModel({
        sessionId: input.session.sessionId,
        turnId: input.turnId,
        agentConfig,
    });
    const response = await (resolved.stream ?? options.stream)(resolved.model, {
        systemPrompt: input.systemPrompt,
        messages: [{ role: 'user', content: input.userPrompt, timestamp: options.nowMs() }],
        ...(input.tools ? { tools: input.tools } : {}),
    }, {
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        ...(resolved.thinkingLevel && resolved.thinkingLevel !== 'off'
            ? { reasoning: resolved.thinkingLevel }
            : {}),
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        signal: AbortSignal.timeout(input.timeoutMs),
    });
    const result = await response.result();
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
        throw new TitleModelCompletionError(result.errorMessage ?? `title LLM ${result.stopReason}`);
    }
    return result;
}
//# sourceMappingURL=title-model-completion.js.map