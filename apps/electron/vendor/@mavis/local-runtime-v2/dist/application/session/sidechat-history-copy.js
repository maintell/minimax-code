import { toolCallFromRuntime } from '@mavis/agent-core/event-bridge';
/** Canonical identities bound the copy; old rows use their surrounding User interval. */
export function selectSideChatDisplayPrefix(display, history) {
    const canonical = canonicalDisplayRecords(history);
    const records = [...canonical.values()];
    const { matched, beforeUser } = matchDisplayPrefix(display, canonical, records);
    const through = [...matched.keys()].at(-1) ?? -1;
    return display.slice(0, through + 1).flatMap((message, index) => {
        if (message.role === 'custom')
            return [];
        const record = matched.get(index);
        if (isAssistant(message) && !record && index > beforeUser)
            return [];
        if (!record || record.message.role !== 'assistant')
            return [structuredClone(message)];
        return [copyAssistant(message, record, records)];
    });
}
function canonicalDisplayRecords(history) {
    const canonical = new Map();
    for (const record of [
        ...history.snapshots.flatMap((snapshot) => snapshot.records),
        ...history.active,
    ]) {
        if (record.message.role !== 'custom' && !canonical.has(record.message_id))
            canonical.set(record.message_id, record);
    }
    return canonical;
}
function matchDisplayPrefix(display, canonical, records) {
    const matched = new Map();
    let candidates = [];
    let beforeUser = -1;
    for (const [index, message] of display.entries()) {
        let record = canonical.get(canonicalIdentity(message));
        if (message.role === 'user') {
            if (record)
                beforeUser = index;
            candidates = assistantInterval(records, record);
        }
        else if (isAssistant(message)) {
            if (!record && !message.canonical_message_id)
                record = candidates[0];
            if (record)
                candidates = candidates.slice(candidates.indexOf(record) + 1);
        }
        if (record)
            matched.set(index, record);
    }
    return { matched, beforeUser };
}
function canonicalIdentity(message) {
    return message.canonical_message_id ?? message.msg_id ?? '';
}
function assistantInterval(records, user) {
    const start = user ? records.indexOf(user) + 1 : records.length;
    const nextUser = records.findIndex((entry, index) => index >= start && entry.message.role === 'user');
    return records
        .slice(start, nextUser < 0 ? undefined : nextUser)
        .filter((entry) => entry.message.role === 'assistant');
}
function isAssistant(message) {
    return message.role === 'assistant' && !message.kind && !message.displayKind;
}
function copyAssistant(display, record, records) {
    const content = record.message.content;
    const parts = Array.isArray(content) ? content.filter(isRecord) : [];
    const text = typeof content === 'string'
        ? content
        : parts
            .flatMap((part) => part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])
            .join('');
    const thinking = parts
        .flatMap((part) => part.type === 'thinking' && typeof part.thinking === 'string' ? [part.thinking] : [])
        .join('');
    const tools = parts.flatMap((part) => {
        if (part.type !== 'toolCall' || typeof part.id !== 'string' || typeof part.name !== 'string')
            return [];
        const result = records.find((entry) => entry.turn_id === record.turn_id &&
            entry.message.role === 'toolResult' &&
            entry.message.toolCallId === part.id)?.message;
        const settledStatus = result ? 'completed' : 'prepared';
        return [
            toolCallFromRuntime({
                tool_call_id: part.id,
                tool_name: part.name,
                status: result?.isError === true ? 'failed' : settledStatus,
                ...(isRecord(part.arguments) ? { args: part.arguments } : {}),
                ...(result
                    ? {
                        result: {
                            content: result.content,
                            ...(result.details === undefined ? {} : { details: result.details }),
                        },
                    }
                    : {}),
            }),
        ];
    });
    const copied = structuredClone(display);
    for (const key of ['msg_content', 'content']) {
        if (key in copied)
            copied[key] = Array.isArray(copied[key]) ? structuredClone(content) : text;
    }
    if ('thinking_content' in copied || thinking)
        copied.thinking_content = thinking;
    if ('tool_calls' in copied || tools.length)
        copied.tool_calls = tools;
    return copied;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=sidechat-history-copy.js.map