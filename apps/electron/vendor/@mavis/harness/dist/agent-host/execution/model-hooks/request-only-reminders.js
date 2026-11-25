/**
 * Copy only the provider view; the canonical user message remains untouched.
 *
 * The reminder stays on the user message that opened the Turn. A user message
 * steered in mid-Turn is appended after it and must not pull the reminder
 * along: moving it would change the bytes of the opening message and rewrite
 * the provider prompt cache for everything after it. One hook serves one Turn,
 * so `content` is fixed for the Turn as well. Only user messages of the durable
 * history are pinned: request-only markers (the Tool Search catalog and its
 * copies) are rebuilt for every request and share one timestamp.
 */
export function createRequestOnlyReminderHook(content) {
    let anchor;
    return (input) => {
        if (!content)
            return undefined;
        const pinnable = canonicalUser(input.canonicalMessages);
        let index = anchor ? findAnchor(input.messages, anchor, pinnable) : -1;
        if (index < 0) {
            // First request of the Turn, or compaction dropped the opening message:
            // pin the latest user message and keep it for the rest of the Turn.
            index = input.messages.length - 1;
            while (index >= 0 && !pinnable(input.messages[index]))
                index--;
            if (index < 0)
                return undefined;
        }
        const messages = [...input.messages];
        const user = messages[index];
        if (user.role !== 'user')
            return undefined;
        anchor = user;
        messages[index] = {
            ...user,
            content: typeof user.content === 'string'
                ? `${user.content}\n\n${content}`
                : [...user.content, { type: 'text', text: content }],
        };
        return { type: 'replaceRequestMessages', reason: 'runtime-request-only-reminders', messages };
    };
}
/** A user message of the durable history, or a request copy of one (same timestamp). */
function canonicalUser(canonical) {
    return (message) => message.role === 'user' &&
        canonical.some((kept) => kept === message || (kept.role === 'user' && kept.timestamp === message.timestamp));
}
/** Compaction copies kept messages, so fall back to the opening message's timestamp. */
function findAnchor(messages, anchor, pinnable) {
    const same = messages.indexOf(anchor);
    if (same >= 0)
        return same;
    if (anchor.role !== 'user')
        return -1;
    return messages.findIndex((message) => pinnable(message) && message.timestamp === anchor.timestamp);
}
//# sourceMappingURL=request-only-reminders.js.map