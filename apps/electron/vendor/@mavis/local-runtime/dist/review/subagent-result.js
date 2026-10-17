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
//# sourceMappingURL=subagent-result.js.map