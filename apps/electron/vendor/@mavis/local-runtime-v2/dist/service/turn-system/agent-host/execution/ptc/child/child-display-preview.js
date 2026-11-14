/**
 * A run_code child's display copy is what the UI, the display table and
 * display.jsonl keep for the conversation: agent-core builds it in
 * `emitPtcChildTerminalEvent` and every one of those three reads that one
 * event. Since children skip the model-visible output caps (agent-tools
 * isPtcChildCall), that copy used to carry whole multi-megabyte results into
 * history, so opening a long conversation had to read tens of megabytes.
 *
 * This bounds it. A child whose text is over 32 KiB keeps a 24 KiB head and an
 * 8 KiB tail with one note in between; the whole text is saved as a Session
 * tool-output artifact — the same writer, directory and read grant
 * `return-spill.ts` uses for oversized run_code return values — and the note
 * names the file, plus the stored format when the repository chunked it. A
 * `read` child is not saved again: its note is two lines, the second naming
 * the file the program already read and the offset to continue from.
 *
 * What never changes: the value the program received, the model-visible
 * result, messages.jsonl, direct calls and children at or below 32 KiB.
 * No platform I/O here either: production composition passes the writer down
 * (LocalRuntimeTurnExecutorOptions.writePtcChildDisplayArtifact).
 */
/** A child at or below this stays byte-for-byte unchanged. */
const PTC_CHILD_DISPLAY_FULL_BYTES = 32 * 1024;
/** Head of the preview, in UTF-8 bytes. */
const PTC_CHILD_DISPLAY_HEAD_BYTES = 24 * 1024;
/** Tail of the preview, in UTF-8 bytes. */
const PTC_CHILD_DISPLAY_TAIL_BYTES = 8 * 1024;
/**
 * A `details` field larger than this is a second copy of the content the note
 * already points at (read's `textFile`, mavis' `output`, bash's
 * `processOutput`), so it is dropped instead of stored twice.
 */
const PTC_CHILD_DISPLAY_DETAIL_BYTES = 1024;
/**
 * The one child whose result is a JSON document the UI parses for its source
 * list (ui `web-source-resolution.ts`). A head-and-tail preview would cut
 * that document in half, so the search card falls back to raw text and the
 * source panel loses every link. Only the page bodies are shortened instead.
 */
const WEB_SEARCH_TOOL_NAME = 'web_search';
/** Marks a `results[].content` value the preview shortened. */
const JSON_FIELD_TRUNCATION_SUFFIX = '...[truncated]';
/**
 * Details the display copy keeps whatever their size. `ptc_child` is the
 * execution record crash recovery and the safety reconciliation read;
 * `source_references` is the list the UI recovers web sources from once a
 * result was externalized or truncated (ui `web-source-resolution.ts`), so
 * shortening it would lose the sources themselves, not a copy of them.
 */
const ALWAYS_KEPT_DETAIL_KEYS = new Set(['ptc_child', 'source_references']);
const EMPTY_STATS = {
    previewChildren: 0,
    spillFailed: 0,
    maxOriginalBytes: 0,
};
export function createPtcChildDisplayPreview(options) {
    const labelTool = options.labelTool ?? (() => 'other');
    const byParent = new Map();
    const shape = async (input) => {
        const content = Array.isArray(input.result.content) ? input.result.content : [];
        const text = joinedText(content);
        const bytes = new TextEncoder().encode(text);
        const originalBytes = bytes.byteLength;
        if (originalBytes <= PTC_CHILD_DISPLAY_FULL_BYTES)
            return input.result;
        const head = decodeHead(bytes, PTC_CHILD_DISPLAY_HEAD_BYTES);
        const tail = decodeTail(bytes, PTC_CHILD_DISPLAY_TAIL_BYTES);
        const keptBytes = utf8Bytes(head) + utf8Bytes(tail);
        const json = webSearchJsonPreview(input.toolName, text);
        const sourcePath = readSourcePath(input.toolName, input.args);
        const spill = sourcePath === undefined
            ? await saveFullText(options, {
                childToolCallId: input.childToolCallId,
                toolName: input.toolName,
                text,
                originalBytes,
            })
            : {
                status: 'skipped',
                reason: 'read',
                sourcePath,
                ...readContinueOffset(head, input, options),
            };
        if (spill.status === 'failed')
            logSpillFailed(options, input, spill.error);
        record(byParent, input.parentToolCallId, originalBytes, spill.status === 'failed');
        reportPreviewMetric(options, labelTool(input.toolName), spill.status);
        const { details, omittedKeys } = shapedDetails(input.result.details);
        // A search result keeps its JSON whole apart from the page bodies, so the
        // UI still reads every title and link; the note stays its own block.
        const previewBlocks = json
            ? [
                { type: 'text', text: json.text },
                {
                    type: 'text',
                    text: previewNotice(json.bytes, originalBytes, spill),
                },
            ]
            : [
                {
                    type: 'text',
                    text: previewText({ head, tail, keptBytes, originalBytes, spill }),
                },
            ];
        return {
            ...input.result,
            // A new array: the executor's display copy shares this one with the
            // tool's own result, which the program already received.
            content: [...previewBlocks, ...nonTextBlocks(content)],
            details: {
                ...details,
                display_truncated: {
                    original_bytes: originalBytes,
                    omitted_detail_keys: omittedKeys,
                    ...(json ? { truncated_json_fields: json.truncatedFields } : {}),
                    ...(spill.status === 'saved' ? { full_output_path: spill.path } : {}),
                    ...(spill.status === 'failed' ? { spill_error: spill.error } : {}),
                    ...(spill.status === 'skipped' ? { spill_skipped: spill.reason } : {}),
                },
            },
        };
    };
    return {
        shape,
        stats: (parentToolCallId) => {
            const entry = byParent.get(parentToolCallId);
            if (!entry)
                return EMPTY_STATS;
            byParent.delete(parentToolCallId);
            return {
                previewChildren: entry.children,
                spillFailed: entry.failed,
                maxOriginalBytes: entry.maxBytes,
            };
        },
    };
}
/** Text of the content blocks, joined the way the executor reads a result. */
function joinedText(content) {
    return content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}
function nonTextBlocks(content) {
    return content.filter((block) => block.type !== 'text');
}
function utf8Bytes(value) {
    return new TextEncoder().encode(value).byteLength;
}
/**
 * First `maxBytes` bytes. `stream: true` holds an incomplete multi-byte
 * sequence at the cut instead of emitting a replacement character.
 */
function decodeHead(bytes, maxBytes) {
    return new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}
/** Last `maxBytes` bytes, skipping the continuation bytes of a split character. */
function decodeTail(bytes, maxBytes) {
    let start = Math.max(0, bytes.byteLength - maxBytes);
    while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80)
        start += 1;
    return new TextDecoder().decode(bytes.subarray(start));
}
function previewText(parts) {
    const { head, tail, keptBytes, originalBytes, spill } = parts;
    return `${head}\n${previewNotice(keptBytes, originalBytes, spill)}\n${tail}`;
}
/**
 * The note the UI shows in place of the omitted middle. Only the display copy
 * carries it: the model and the program never see this text. It states how much
 * of the result this copy kept, so a card never has to work that out from two
 * rounded sizes. A `read` note breaks after the first sentence: the card is
 * one column wide, and the path plus the offset are the part that has to stay
 * visible.
 */
function previewNotice(keptBytes, originalBytes, spill) {
    const head = `[... Showing ${formatBytes(keptBytes)} of ${formatBytes(originalBytes)} in this display copy. The run_code program received the full result`;
    if (spill.status === 'saved') {
        // Same wording as the tool output budget's receipt for a chunked artifact.
        const chunked = spill.chunked
            ? " Artifact format: chunked JSONL; concatenate each chunk row's text field in index order."
            : '';
        return `${head}; the full text is saved at ${spill.path}. Read it with the read tool and continue with offset.${chunked}]`;
    }
    if (spill.status === 'failed') {
        return `${head}; the full text could not be saved (${spill.error}).]`;
    }
    const offset = spill.offset === undefined ? '' : ` and continue with offset=${spill.offset}`;
    return `${head}\nRead ${spill.sourcePath} with the read tool${offset}.]`;
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Shortens only `results[].content` so the whole document still parses and the
 * UI keeps every source. Every other key, including `title`, `link`,
 * `snippet`, `source`, `code`, `message` and `total`, is left byte for byte.
 *
 * Returns undefined — and the caller falls back to the head-and-tail preview —
 * when this is not a web_search child, the text is not JSON, `results` is not
 * an array, no result carries a string `content`, or emptying every body
 * still leaves the document over the budget.
 */
function webSearchJsonPreview(toolName, text) {
    if (toolName !== WEB_SEARCH_TOOL_NAME)
        return undefined;
    const parsed = parseJson(text);
    if (!isRecord(parsed) || !Array.isArray(parsed.results))
        return undefined;
    const bodies = searchResultBodies(parsed.results);
    if (bodies.length === 0)
        return undefined;
    const document = jsonBodyBudget(parsed, bodies);
    return document;
}
/** Every `results[]` entry that carries a string `content`, with its UTF-8 bytes. */
function searchResultBodies(results) {
    const bodies = [];
    results.forEach((entry, index) => {
        if (!isRecord(entry) || typeof entry.content !== 'string')
            return;
        bodies.push({ index, value: entry.content, bytes: new TextEncoder().encode(entry.content) });
    });
    return bodies;
}
/**
 * The largest per-body limit whose document still fits the budget, then the
 * document built with it. Sizes are summed per field instead of serializing
 * the whole document on every probe: the document's own size with empty
 * bodies is fixed, and each body only adds its quoted value from there.
 */
function jsonBodyBudget(parsed, bodies) {
    const base = utf8Bytes(stringifyWithBodies(parsed, bodies, () => ''));
    if (base > PTC_CHILD_DISPLAY_FULL_BYTES)
        return undefined;
    const suffixBytes = quotedBytes(JSON_FIELD_TRUNCATION_SUFFIX) - EMPTY_QUOTED_BYTES;
    const sizeAt = (limit) => base +
        bodies.reduce((total, body) => total +
            (body.bytes.byteLength <= limit
                ? quotedBytes(body.value) - EMPTY_QUOTED_BYTES
                : quotedBytes(decodeHead(body.bytes, limit)) - EMPTY_QUOTED_BYTES + suffixBytes), 0);
    const limit = largestFittingLimit(sizeAt, Math.max(...bodies.map((body) => body.bytes.byteLength)));
    if (limit === undefined)
        return undefined;
    const text = stringifyWithBodies(parsed, bodies, (body) => body.bytes.byteLength <= limit
        ? body.value
        : `${decodeHead(body.bytes, limit)}${JSON_FIELD_TRUNCATION_SUFFIX}`);
    return {
        text,
        bytes: utf8Bytes(text),
        truncatedFields: bodies.filter((body) => body.bytes.byteLength > limit).length,
    };
}
/**
 * Largest limit in `[0, maximum]` whose document fits. Each body grows with
 * the limit and then drops back to its own length once the limit reaches it,
 * so the probe is a binary search followed by a bounded walk that both repairs
 * a bad landing and pushes the limit as high as it still fits.
 */
function largestFittingLimit(sizeAt, maximum) {
    let low = 0;
    let high = maximum;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (sizeAt(middle) <= PTC_CHILD_DISPLAY_FULL_BYTES)
            low = middle;
        else
            high = middle - 1;
    }
    let limit = low;
    while (limit > 0 && sizeAt(limit) > PTC_CHILD_DISPLAY_FULL_BYTES)
        limit -= 1;
    if (sizeAt(limit) > PTC_CHILD_DISPLAY_FULL_BYTES)
        return undefined;
    while (limit < maximum && sizeAt(limit + 1) <= PTC_CHILD_DISPLAY_FULL_BYTES)
        limit += 1;
    return limit;
}
/** The parsed document with every body's `content` replaced, serialized as the display stores it. */
function stringifyWithBodies(parsed, bodies, body) {
    const results = [...parsed.results];
    for (const entry of bodies) {
        const original = results[entry.index];
        if (isRecord(original))
            results[entry.index] = { ...original, content: body(entry) };
    }
    return JSON.stringify({ ...parsed, results });
}
/** `JSON.stringify` of a string, quotes included, in UTF-8 bytes. */
function quotedBytes(value) {
    return utf8Bytes(JSON.stringify(value));
}
/** `JSON.stringify('')` is the two quote bytes every replaced body leaves behind. */
const EMPTY_QUOTED_BYTES = 2;
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
/** `read` already has the whole file on disk, so its preview points back at it. */
function readSourcePath(toolName, args) {
    if (toolName !== 'read')
        return undefined;
    const path = args.path;
    return typeof path === 'string' && path.trim() !== '' ? path : undefined;
}
/**
 * The line to continue a `read` from: the file line after the last complete
 * line the head preview kept. Desktop read numbers its output, so that number
 * is read back; without it the details' start line plus the kept line count
 * gives the same answer.
 */
function readContinueOffset(head, input, options) {
    const offset = continueOffset(head, input.result.details);
    if (offset !== undefined)
        return { offset };
    logOffsetUnavailable(options, input);
    return {};
}
function continueOffset(head, details) {
    const lastBreak = head.lastIndexOf('\n');
    if (lastBreak <= 0)
        return undefined;
    const complete = head.slice(0, lastBreak);
    const lastLine = complete.slice(complete.lastIndexOf('\n') + 1);
    const numbered = /^\s*(\d+)[\u2192\t]/u.exec(lastLine);
    if (numbered?.[1])
        return Number(numbered[1]) + 1;
    const startLine = readStartLine(details);
    if (startLine === undefined)
        return undefined;
    return startLine + complete.split('\n').length;
}
function readStartLine(details) {
    const textFile = isRecord(details) ? details.textFile : undefined;
    const startLine = isRecord(textFile) ? textFile.startLine : undefined;
    return typeof startLine === 'number' && Number.isSafeInteger(startLine) && startLine > 0
        ? startLine
        : undefined;
}
async function saveFullText(options, call) {
    const write = options.writeArtifact;
    if (!write)
        return { status: 'failed', error: 'writer_unavailable' };
    try {
        const artifact = await write({
            sessionId: options.sessionId,
            turnId: options.turnId,
            toolCallId: call.childToolCallId,
            toolName: call.toolName,
            text: call.text,
            originalBytes: call.originalBytes,
            sensitive: false,
        });
        return {
            status: 'saved',
            path: artifact.reference,
            chunked: artifact.metadata?.read_format === 'chunked_jsonl_v1',
        };
    }
    catch (error) {
        const code = error?.code;
        return { status: 'failed', error: typeof code === 'string' ? code : 'write_failed' };
    }
}
/**
 * The always-kept fields stay whole; every other field is kept only while it
 * is small enough not to be a second copy of the content.
 */
function shapedDetails(details) {
    const source = isRecord(details) ? details : {};
    const kept = {};
    const omittedKeys = [];
    for (const [key, value] of Object.entries(source)) {
        if (ALWAYS_KEPT_DETAIL_KEYS.has(key) || detailBytes(value) <= PTC_CHILD_DISPLAY_DETAIL_BYTES) {
            kept[key] = value;
            continue;
        }
        omittedKeys.push(key);
    }
    return { details: kept, omittedKeys };
}
/** Serialized size of one details field; a value that cannot be serialized is oversized. */
function detailBytes(value) {
    try {
        return new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength;
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
function record(byParent, parentToolCallId, originalBytes, failed) {
    const entry = byParent.get(parentToolCallId) ?? { children: 0, failed: 0, maxBytes: 0 };
    byParent.set(parentToolCallId, {
        children: entry.children + 1,
        failed: entry.failed + (failed ? 1 : 0),
        maxBytes: Math.max(entry.maxBytes, originalBytes),
    });
}
function reportPreviewMetric(options, tool, status) {
    try {
        options.metrics?.counter('ptc_child_display_preview_total', 1, { tool, spill: status });
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
/** One line per failed save; never logs content or paths. */
function logSpillFailed(options, input, error) {
    try {
        options.logger?.warn?.({
            session_id: options.sessionId,
            turn_id: options.turnId,
            child_tool_call_id: input.childToolCallId,
            parent_tool_call_id: input.parentToolCallId,
            tool_name: input.toolName,
            spill_error: error,
        }, 'ptc child display copy was not saved');
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
/** The preview kept no complete line, so the note cannot name an offset. */
function logOffsetUnavailable(options, input) {
    try {
        options.logger?.warn?.({
            session_id: options.sessionId,
            turn_id: options.turnId,
            child_tool_call_id: input.childToolCallId,
            parent_tool_call_id: input.parentToolCallId,
            tool_name: input.toolName,
        }, 'ptc child display copy has no read continue offset');
    }
    catch {
        // Diagnostics must not change the child outcome.
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=child-display-preview.js.map