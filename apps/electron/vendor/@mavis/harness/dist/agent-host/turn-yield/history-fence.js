/**
 * Keeps output written after a yield stop out of committed history. Before the
 * stop every change passes unchanged. After it only plain `messageDelta` tool
 * results of calls that history already holds pass: all of them for a `tail`
 * stop, and only the successful ones for a `pending-tool-calls` stop, whose
 * interrupted calls run again on resume. Assistant Display ids never pass
 * after the stop: the continuation commits the assistant under its own id.
 */
export class TurnYieldHistoryFence {
    stoppedAt;
    knownToolCallIds = new Set();
    constructor(initialMessages, stoppedAt) {
        this.stoppedAt = stoppedAt;
        this.remember(initialMessages);
    }
    admit(change) {
        const resumeFrom = this.stoppedAt();
        if (resumeFrom === undefined) {
            this.remember(change.messages);
            return change;
        }
        if (!isPlainMessageDelta(change))
            return undefined;
        // Only tool results pass after a stop, so no assistant Display id applies.
        const { assistantMessageIds, ...plain } = change;
        const messages = plain.messages.filter((message) => this.keeps(message, resumeFrom));
        if (messages.length === 0)
            return undefined;
        const unchanged = messages.length === plain.messages.length && assistantMessageIds === undefined;
        return unchanged ? change : { ...plain, messages };
    }
    keeps(message, resumeFrom) {
        if (message.role !== 'toolResult' || !this.knownToolCallIds.has(message.toolCallId)) {
            return false;
        }
        return resumeFrom === 'tail' || message.isError !== true;
    }
    remember(messages) {
        for (const message of messages) {
            if (message.role !== 'assistant')
                continue;
            for (const part of message.content) {
                if (part.type === 'toolCall')
                    this.knownToolCallIds.add(part.id);
            }
        }
    }
}
function isPlainMessageDelta(change) {
    return (change.reason === 'messageDelta' &&
        change.operation === undefined &&
        change.identityHints === undefined &&
        change.replacementEntries === undefined &&
        change.metadata === undefined);
}
//# sourceMappingURL=history-fence.js.map