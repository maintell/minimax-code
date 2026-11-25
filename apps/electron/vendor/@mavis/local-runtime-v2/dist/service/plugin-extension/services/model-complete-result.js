export function usageOf(usage) {
    return usage ? { inputTokens: usage.input, outputTokens: usage.output } : undefined;
}
export function classify(result, timedOut, aborted) {
    if (timedOut)
        return { isAnswered: false, reason: 'timeout' };
    if (aborted || result.stopReason === 'aborted')
        return { isAnswered: false, reason: 'aborted' };
    if (result.stopReason === 'error')
        return { isAnswered: false, reason: 'provider-error' };
    const text = result.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('')
        .trim();
    return text === '' ? { isAnswered: false, reason: 'empty-reply' } : { isAnswered: true, text };
}
//# sourceMappingURL=model-complete-result.js.map