/**
 * Splits a Turn's prompt and history into its layers. `segmentPrefixLength`
 * is how many records at the head of the history the last checkpoint wrote
 * (header and retained text); 0 before any checkpoint.
 */
export function splitTurnStateLayers(input) {
    const { history, segmentPrefixLength } = input;
    const header = isHandoffHeader(history[0]) ? history[0] : undefined;
    const bodyStart = header === undefined ? 0 : 1;
    return {
        ...splitMemory(input.systemPrompt, input.promptRanges ?? []),
        ...(header === undefined ? {} : { handoffHeader: header }),
        ...(segmentPrefixLength === undefined
            ? {}
            : {
                retainedText: history.slice(bodyStart, Math.max(bodyStart, segmentPrefixLength)),
                segmentConversation: history.slice(Math.max(bodyStart, segmentPrefixLength)),
            }),
    };
}
function splitMemory(systemPrompt, ranges) {
    const memory = ranges
        .filter((range) => range.kind === 'MEMORY')
        .sort((left, right) => left.startOffset - right.startOffset);
    let rest = '';
    let cursor = 0;
    for (const range of memory) {
        rest += systemPrompt.slice(cursor, Math.max(cursor, range.startOffset));
        cursor = Math.max(cursor, range.endOffset);
    }
    return {
        systemPrompt: rest + systemPrompt.slice(cursor),
        memory: memory.map((range) => systemPrompt.slice(range.startOffset, range.endOffset)).join(''),
    };
}
export function isHandoffHeader(message) {
    return (!!message && typeof message === 'object' && Reflect.get(message, 'role') === 'compactionSummary');
}
//# sourceMappingURL=turn-layers.js.map