export function filterCompactedNativeMessages(messages) {
    const result = messages;
    const warnings = [];
    // ── verbatim from opencode filterCompacted ─────────────────────────
    // Target lib is ES2022 in this workspace and `Array.findLastIndex` is
    // ES2023-only; use a manual reverse loop with an equivalent predicate
    // (this is the ONE unavoidable syntactic accommodation vs opencode's
    // `.findLastIndex(...)`; semantics stay identical — first match seen
    // when scanning from the tail).
    let compactionIndex = -1;
    for (let i = result.length - 1; i >= 0; i -= 1) {
        const msg = result[i];
        if (msg &&
            msg.role === 'user' &&
            msg.parts.some((candidate) => candidate.type === 'compaction' && readCompactionTailStartId(candidate) !== undefined)) {
            compactionIndex = i;
            break;
        }
    }
    const compaction = compactionIndex >= 0 ? result[compactionIndex] : undefined;
    const part = compaction?.parts.find((item) => item.type === 'compaction' && readCompactionTailStartId(item) !== undefined);
    const tailStartId = part ? readCompactionTailStartId(part) : undefined;
    const summaryIndex = compaction
        ? result.findIndex((msg, index) => index > compactionIndex &&
            msg.role === 'assistant' &&
            readMessageSummaryFlag(msg) === true &&
            readMessageParentId(msg) === compaction.id)
        : -1;
    const tailIndex = tailStartId ? result.findIndex((msg) => msg.id === tailStartId) : -1;
    if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
        return {
            messages: [
                ...result.slice(compactionIndex, summaryIndex + 1), // [compaction-user, summary]
                ...result.slice(tailIndex, compactionIndex), // tail messages
                ...result.slice(summaryIndex + 1), // 后续对话
            ],
            warnings,
        };
    }
    // ── /verbatim ──────────────────────────────────────────────────────
    // Anything below here is our own diagnostics layer — opencode's
    // filterCompacted just returns `result` unchanged in these branches.
    // We add structured `warnings` so ops can spot data-shape drift.
    if (compactionIndex >= 0 && !tailStartId && compaction) {
        warnings.push(`compaction_part_missing_tail_start_id:${compaction.id}`);
    }
    if (compactionIndex >= 0 && tailStartId && tailIndex < 0 && compaction) {
        warnings.push(`compaction_tail_start_id_unresolved:${compaction.id}:${tailStartId}`);
    }
    if (compactionIndex >= 0 && tailStartId && tailIndex >= 0 && summaryIndex < 0 && compaction) {
        warnings.push(`compaction_summary_missing:${compaction.id}`);
    }
    return { messages: result, warnings };
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
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value === 'string' && value.length > 0) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            /* fall through */
        }
    }
    return undefined;
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
//# sourceMappingURL=legacy-opencode-native-compaction-filter.js.map