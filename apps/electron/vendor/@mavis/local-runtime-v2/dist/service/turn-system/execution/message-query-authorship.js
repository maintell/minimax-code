/** Resolves exact user-query authorship before execution and display diverge. */
export function resolveGenuineUserQueryText(input) {
    const displayContent = input.delivery?.displayContent;
    if (typeof displayContent === 'string' && displayContent.length > 0)
        return displayContent;
    if (input.delivery?.hideUserMessage === true)
        return '';
    return isUserAuthoredSource(input.provenance.source) ? input.input.text : '';
}
export function isUserAuthoredSource(source) {
    return (source === 'api' ||
        source === 'code_review' ||
        source === 'channel' ||
        source.startsWith('channel:'));
}
/** Identifies queued user work that must preempt an autonomous Goal continuation. */
export function hasPriorityUserQueueItem(items) {
    return items.some(({ source }) => source === 'api' ||
        source === 'questionnaire' ||
        source === 'communication' ||
        source === 'code_review' ||
        source.startsWith('channel:'));
}
//# sourceMappingURL=message-query-authorship.js.map