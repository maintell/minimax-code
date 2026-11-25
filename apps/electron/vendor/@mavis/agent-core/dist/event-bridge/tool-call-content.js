/**
 * Turn-local, in-process view of what each tool call of a turn actually carried: the argument
 * object the agent issued and the result the model receives. {@link EventBridge} records into it
 * before any display sanitization; a host reads it lazily after it has committed the frame that
 * names the call. It holds references only, copies nothing, and never enters a RuntimeEvent,
 * snapshot, persistence or telemetry.
 */
/**
 * Created by the host when a turn starts and closed when it ends or aborts; after `close` every
 * lookup misses and further records are ignored. One registry spans every attempt of the turn.
 */
export class TurnToolCallContent {
    records = new Map();
    /** Called by the bridge at `tool_execution_start`. */
    recordStart(toolCallId, args) {
        this.records?.set(toolCallId, { args, ended: false });
    }
    /** Called by the bridge once the call has its final (post-hook) result. */
    recordEnd(toolCallId, result) {
        const record = this.records?.get(toolCallId);
        if (!record)
            return;
        record.ended = true;
        record.result = result;
    }
    get(toolCallId) {
        const record = this.records?.get(toolCallId);
        if (!record)
            return undefined;
        return {
            input: () => record.args,
            output: () => (record.ended ? modelOutput(record.result) : undefined),
        };
    }
    release(toolCallId) {
        this.records?.delete(toolCallId);
    }
    close() {
        this.records = undefined;
    }
}
function modelOutput(result) {
    const content = isRecord(result) ? result['content'] : undefined;
    if (!Array.isArray(content))
        return {};
    const texts = [];
    let hasNonText = false;
    for (const block of content) {
        if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
            texts.push(block['text']);
        }
        else {
            hasNonText = true;
        }
    }
    return {
        ...(texts.length > 0 ? { text: texts.join('\n') } : {}),
        ...(hasNonText ? { result: content } : {}),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
//# sourceMappingURL=tool-call-content.js.map