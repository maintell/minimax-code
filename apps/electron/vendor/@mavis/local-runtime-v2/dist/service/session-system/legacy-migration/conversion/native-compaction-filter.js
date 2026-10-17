export function filterCompactedNativeMessages(messages) {
    const result = messages;
    const window = findCompactionWindow(result);
    if (isValidCompactionWindow(window)) {
        return {
            messages: [
                ...result.slice(window.compactionIndex, window.summaryIndex + 1),
                ...result.slice(window.tailIndex, window.compactionIndex),
                ...result.slice(window.summaryIndex + 1),
            ],
            warnings: [],
        };
    }
    return { messages: result, warnings: compactionWarnings(window) };
}
function findCompactionWindow(messages) {
    const compactionIndex = findLatestCompactionIndex(messages);
    const compaction = messageAt(messages, compactionIndex);
    const tailStartId = compactionTailStartId(compaction);
    return {
        compactionIndex,
        compaction,
        tailStartId,
        tailIndex: findMessageIndex(messages, tailStartId),
        summaryIndex: findSummaryIndex(messages, compactionIndex, compaction),
    };
}
function findLatestCompactionIndex(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (isCompactionMessage(messages[index]))
            return index;
    }
    return -1;
}
function isCompactionMessage(message) {
    if (message?.role !== 'user')
        return false;
    return message.parts.some(isCompactionPartWithTail);
}
function isCompactionPartWithTail(part) {
    return part.type === 'compaction' && readCompactionTailStartId(part) !== undefined;
}
function messageAt(messages, index) {
    return index < 0 ? undefined : messages[index];
}
function compactionTailStartId(compaction) {
    const part = compaction?.parts.find(isCompactionPartWithTail);
    return part ? readCompactionTailStartId(part) : undefined;
}
function findMessageIndex(messages, messageId) {
    return messageId ? messages.findIndex(({ id }) => id === messageId) : -1;
}
function findSummaryIndex(messages, compactionIndex, compaction) {
    if (!compaction)
        return -1;
    return messages.findIndex((message, index) => index > compactionIndex &&
        message.role === 'assistant' &&
        readMessageSummaryFlag(message) &&
        readMessageParentId(message) === compaction.id);
}
function isValidCompactionWindow(window) {
    if (window.tailIndex < 0)
        return false;
    if (window.tailIndex >= window.compactionIndex)
        return false;
    return window.summaryIndex > window.compactionIndex;
}
function compactionWarnings(window) {
    return [
        missingTailWarning(window),
        unresolvedTailWarning(window),
        missingSummaryWarning(window),
    ].filter((warning) => warning !== undefined);
}
function missingTailWarning(window) {
    if (window.compactionIndex < 0 || window.tailStartId || !window.compaction)
        return undefined;
    return `compaction_part_missing_tail_start_id:${window.compaction.id}`;
}
function unresolvedTailWarning(window) {
    if (!window.compaction || !window.tailStartId || window.tailIndex >= 0)
        return undefined;
    return `compaction_tail_start_id_unresolved:${window.compaction.id}:${window.tailStartId}`;
}
function missingSummaryWarning(window) {
    if (!window.compaction || !window.tailStartId)
        return undefined;
    if (window.tailIndex < 0 || window.summaryIndex >= 0)
        return undefined;
    return `compaction_summary_missing:${window.compaction.id}`;
}
/**
 * Read `tail_start_id` from an opencode compaction part. Opencode 0.7+
 * uses `snake_case` inside `data`, older builds may have used camelCase
 * or hoisted the field onto the raw row — try each in priority order so
 * cross-version data stays readable.
 */
function readCompactionTailStartId(part) {
    const dataRecord = readObject(part.data);
    const rawRecord = part.raw;
    return (readString(dataRecord, ['tail_start_id', 'tailStartId']) ??
        readString(rawRecord, ['tail_start_id', 'tailStartId']));
}
/**
 * Read the `summary: true` flag from an opencode message. On 0.7+ the
 * store may hoist the flag onto the outer row, but the truth normally
 * lives inside the JSON `data` blob. We try both: outer row first (fast
 * path), then the parsed `data`, then any lifted `raw.data` block on
 * legacy shapes.
 */
function readMessageSummaryFlag(message) {
    const raw = message.raw;
    if (raw && typeof raw['summary'] === 'boolean')
        return raw['summary'] === true;
    const dataRecord = extractDataRecord(raw);
    if (dataRecord && typeof dataRecord['summary'] === 'boolean') {
        return dataRecord['summary'] === true;
    }
    return false;
}
/**
 * Read `parentID` (opencode 0.7+) or `parent_id` (older builds), first
 * on the raw envelope and then inside `data`, so cross-version data
 * stays traceable.
 */
function readMessageParentId(message) {
    const raw = message.raw;
    const rawParent = readString(raw, ['parentID', 'parent_id']);
    if (rawParent)
        return rawParent;
    const dataRecord = extractDataRecord(raw);
    return readString(dataRecord, ['parentID', 'parent_id']);
}
/**
 * `LegacyOpencodeStore.nativeMessageFromRow` stashes the raw SQLite row
 * under `.raw`, so any JSON-encoded fields (`summary`, `parentID`,
 * `data` payload) still live inside `raw.data` as a string. Try both:
 * an already-parsed object (older tests / builds) and the string form.
 */
function extractDataRecord(raw) {
    if (!raw)
        return undefined;
    const value = raw['data'];
    const direct = readObject(value);
    if (direct)
        return direct;
    if (typeof value === 'string' && value.length > 0)
        return parseDataRecord(value);
    return undefined;
}
function parseDataRecord(raw) {
    try {
        return readObject(JSON.parse(raw));
    }
    catch {
        return undefined;
    }
}
function readObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
function readString(record, keys) {
    if (!record)
        return undefined;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0)
            return value;
    }
    return undefined;
}
//# sourceMappingURL=native-compaction-filter.js.map