/**
 * The text the user wrote in a canonical user message, from the provenance the
 * Host records when it submits the Turn. Host-submitted inputs (Goal
 * continuations, session send, scheduled runs, background notices) carry an
 * empty query, and messages written before the provenance existed carry none.
 */
export function readGenuineUserQueryText(message) {
    if (Object.hasOwn(message, 'genuineUserQueryText')) {
        const text = Reflect.get(message, 'genuineUserQueryText');
        return typeof text === 'string' ? text : undefined;
    }
    if (!Object.hasOwn(message, 'canonicalTextRange'))
        return undefined;
    return readCanonicalRangeText(message);
}
function readCanonicalRangeText(message) {
    const content = readSingleText(message);
    const range = Reflect.get(message, 'canonicalTextRange');
    if (!content || !range || typeof range !== 'object')
        return undefined;
    const startOffset = Reflect.get(range, 'startOffset');
    const endOffset = Reflect.get(range, 'endOffset');
    if (!Number.isSafeInteger(startOffset) ||
        !Number.isSafeInteger(endOffset) ||
        startOffset < 0 ||
        endOffset < startOffset ||
        endOffset > content.length) {
        return undefined;
    }
    return content.slice(startOffset, endOffset);
}
function readSingleText(message) {
    const content = Reflect.get(message, 'content');
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return undefined;
    const texts = content.flatMap((block) => block && typeof block === 'object' && Reflect.get(block, 'type') === 'text'
        ? [Reflect.get(block, 'text')]
        : []);
    return texts.length === 1 && typeof texts[0] === 'string' ? texts[0] : undefined;
}
/** A user message carrying text the user wrote, excluding legacy compaction boundaries. */
export function isGenuineUserInput(message) {
    return (message.role === 'user' &&
        !Reflect.get(message, 'archonCompaction') &&
        Boolean(readGenuineUserQueryText(message)?.trim()));
}
//# sourceMappingURL=genuine-user-query.js.map