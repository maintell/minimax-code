import { toolCallFromRuntime } from '@mavis/agent-core/event-bridge';
import { canonicalHistoryRecordEntry, } from '../../service/session-system/index.js';
/**
 * Canonical identities bound the copy; old rows use their surrounding User interval. Matching
 * uses record entries only; the records a copied Assistant row needs are then streamed from
 * their generation, so archived history is never held as a whole.
 */
export async function selectSideChatDisplayPrefix(display, history) {
    const canonical = canonicalDisplayEntries(history);
    const entries = [...canonical.values()];
    const { matched, beforeUser } = matchDisplayPrefix(display, canonical, entries);
    const through = [...matched.keys()].at(-1) ?? -1;
    const copiedAssistants = display.slice(0, through + 1).flatMap((message, index) => {
        const entry = matched.get(index);
        return message.role !== 'custom' && entry?.role === 'assistant' ? [entry] : [];
    });
    const records = await loadRecords(history, neededEntries(copiedAssistants, entries));
    return display.slice(0, through + 1).flatMap((message, index) => {
        if (message.role === 'custom')
            return [];
        const entry = matched.get(index);
        if (isAssistant(message) && !entry && index > beforeUser)
            return [];
        if (!entry || entry.role !== 'assistant')
            return [structuredClone(message)];
        const record = records.get(entry);
        if (!record)
            throw new Error(`SideChat canonical record was not loaded: ${entry.messageId}`);
        return [
            copyAssistant(message, record, (callId) => toolResultFor(entry, callId, entries, records)),
        ];
    });
}
/** First occurrence of every non-custom identity, archived generations first. */
function canonicalDisplayEntries(history) {
    const canonical = new Map();
    const add = (entry, source, index) => {
        if (entry.role !== 'custom' && !canonical.has(entry.messageId))
            canonical.set(entry.messageId, { ...entry, source, index });
    };
    history.snapshots.forEach((snapshot, source) => snapshot.entries.forEach((entry, index) => add(entry, source, index)));
    history.active.forEach((record, index) => add(canonicalHistoryRecordEntry(record), -1, index));
    return canonical;
}
function matchDisplayPrefix(display, canonical, entries) {
    const matched = new Map();
    let candidates = [];
    let beforeUser = -1;
    for (const [index, message] of display.entries()) {
        let entry = canonical.get(canonicalIdentity(message));
        if (message.role === 'user') {
            if (entry)
                beforeUser = index;
            candidates = assistantInterval(entries, entry);
        }
        else if (isAssistant(message)) {
            if (!entry && !message.canonical_message_id)
                entry = candidates[0];
            if (entry)
                candidates = candidates.slice(candidates.indexOf(entry) + 1);
        }
        if (entry)
            matched.set(index, entry);
    }
    return { matched, beforeUser };
}
function canonicalIdentity(message) {
    return message.canonical_message_id ?? message.msg_id ?? '';
}
function assistantInterval(entries, user) {
    const start = user ? entries.indexOf(user) + 1 : entries.length;
    const nextUser = entries.findIndex((entry, index) => index >= start && entry.role === 'user');
    return entries
        .slice(start, nextUser < 0 ? undefined : nextUser)
        .filter((entry) => entry.role === 'assistant');
}
/** The first tool result in the same Turn that answers a call; the order matches the copy. */
function toolResultEntry(assistant, callId, entries) {
    return entries.find((entry) => entry.turnId === assistant.turnId &&
        entry.role === 'toolResult' &&
        entry.toolCallId === callId);
}
function toolResultFor(assistant, callId, entries, records) {
    const entry = toolResultEntry(assistant, callId, entries);
    return entry ? records.get(entry)?.message : undefined;
}
function neededEntries(assistants, entries) {
    const needed = new Set(assistants);
    for (const assistant of assistants) {
        for (const callId of assistant.toolCallIds ?? []) {
            const result = toolResultEntry(assistant, callId, entries);
            if (result)
                needed.add(result);
        }
    }
    return needed;
}
/** Reads only the needed records: active ones directly, archived ones one generation at a time. */
async function loadRecords(history, needed) {
    const records = new Map();
    const bySource = new Map();
    for (const entry of needed) {
        if (entry.source < 0) {
            const record = history.active[entry.index];
            if (record)
                records.set(entry, record);
            continue;
        }
        const indexes = bySource.get(entry.source) ?? new Map();
        indexes.set(entry.index, entry);
        bySource.set(entry.source, indexes);
    }
    for (const [source, indexes] of bySource) {
        const snapshot = history.snapshots[source];
        if (!snapshot)
            continue;
        await history.forEachSnapshotRecord(snapshot, (record, index) => {
            const entry = indexes.get(index);
            if (entry)
                records.set(entry, record);
        });
    }
    return records;
}
function isAssistant(message) {
    return message.role === 'assistant' && !message.kind && !message.displayKind;
}
function copyAssistant(display, record, toolResult) {
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
        const result = toolResult(part.id);
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