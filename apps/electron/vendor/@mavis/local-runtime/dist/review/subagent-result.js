export function normalizeSubagentFinalText(text) {
    if (!/^\s*<annotation-result\b/iu.test(text))
        return text;
    return text.replace(/(<annotation-result\b[^>]*\bmode=)(["'])inline\2/iu, '$1$2subagent$2');
}
export function isProjectedReviewResult(text) {
    return /^\s*<annotation-result\b[\s\S]*<\/annotation-result>\s*$/iu.test(text);
}
export async function waitForReviewCompletion(conversation, sessionId, completion, signal) {
    if (!signal)
        return completion;
    let onAbort;
    const aborted = new Promise((resolve) => {
        onAbort = () => {
            void conversation.ingress.abort(sessionId, 'review_parent_aborted');
            resolve({ status: 'aborted', messages: [] });
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        return await Promise.race([completion, aborted]);
    }
    finally {
        if (onAbort)
            signal.removeEventListener('abort', onAbort);
    }
}
/** The review subagent's outcome from its completed round: its projected annotation result. */
export function reviewSubagentResult(result) {
    if (result.status !== 'completed') {
        return result.status === 'aborted'
            ? { status: 'aborted' }
            : { status: 'failed', errorMessage: result.error ?? 'Review subagent failed.' };
    }
    const finalText = [...result.messages]
        .reverse()
        .find((message) => message.role === 'assistant' && message.text?.trim())
        ?.text?.trim();
    if (!finalText) {
        return { status: 'failed', errorMessage: 'Review subagent returned no final response.' };
    }
    const normalized = normalizeSubagentFinalText(finalText);
    if (!isProjectedReviewResult(normalized)) {
        return {
            status: 'failed',
            errorMessage: 'Review subagent did not return a projected annotation result.',
        };
    }
    return { status: 'succeeded', finalText: normalized };
}
//# sourceMappingURL=subagent-result.js.map