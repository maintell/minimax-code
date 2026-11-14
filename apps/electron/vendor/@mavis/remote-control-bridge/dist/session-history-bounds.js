/**
 * Size bounds for one Remote Control history page.
 *
 * A `cmd.session.history` page is built in the Electron main process and
 * shipped to the phone in a single frame, so an unbounded page is an
 * unbounded allocation on the way out. Nothing here touches local storage:
 * the Desktop renderer still shows the full tool output, only the
 * phone-facing reply is bounded.
 */
/**
 * Per-field cap for `tool_call_result_data` / `tool_call_args` inside an RC
 * history page. Local storage is untouched — only the phone-facing reply is
 * bounded, so the desktop renderer still shows the full tool output.
 */
export const RC_HISTORY_TOOL_FIELD_MAX_BYTES = 64 * 1024;
/** Encoded `messages_json` cap for one RC history page. */
export const RC_HISTORY_PAGE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Kept head/tail of a truncated tool field. Tool failures are reported at the
 * tail, so dropping the middle loses the least information.
 */
const RC_HISTORY_TOOL_FIELD_HEAD_BYTES = 48 * 1024;
/**
 * Floor below which a string inside a JSON tool-argument value is never
 * shortened. `file_path`, flags and other short arguments must survive
 * verbatim next to a giant `content`, so only values that are themselves
 * large are candidates for truncation.
 */
const RC_HISTORY_JSON_MIN_STRING_BYTES = 1024;
/**
 * Bound one RC history page for the phone without touching local storage.
 *
 * 1. Every oversized `tool_calls[].tool_call_result_data` / `tool_call_args`
 *    keeps its head and tail with a notice in between. `msg_content`,
 *    `thinking_content` and `raw_json` are deliberately left alone —
 *    `raw_json` is fixed on the runtime side and ships in the same desktop
 *    build, but it still counts towards the page size below.
 * 2. If the encoded page still exceeds RC_HISTORY_PAGE_MAX_BYTES, drop the
 *    oldest messages until it fits. The newest message always survives so the
 *    phone can keep paging forward; a single still-oversized message has its
 *    string fields shortened largest-first instead.
 */
export function boundHistoryPage(messages, notice) {
    let truncatedFields = 0;
    const bounded = messages.map((message) => {
        const result = truncateMessageToolFields(message, notice);
        truncatedFields += result.truncatedFields;
        return result.message;
    });
    // Encode each message once and assemble the array textually: JSON.stringify
    // of an array is exactly `[` + elements joined by `,` + `]`, so suffix sums
    // answer "how many oldest messages must go" without re-serializing the page
    // once per dropped row.
    const encoded = bounded.map((message) => JSON.stringify(message) ?? 'null');
    const sizes = encoded.map((text) => Buffer.byteLength(text, 'utf8'));
    const suffixBytes = (startIndex) => {
        let total = 2; // "[" + "]"
        for (let index = startIndex; index < sizes.length; index += 1) {
            total += sizes[index] + (index > startIndex ? 1 : 0);
        }
        return total;
    };
    if (bounded.length === 0) {
        return {
            messages: [],
            messagesJson: '[]',
            bytes: 2,
            truncatedFields,
            droppedMessages: 0,
        };
    }
    let firstKept = 0;
    while (firstKept < bounded.length - 1 && suffixBytes(firstKept) > RC_HISTORY_PAGE_MAX_BYTES) {
        firstKept += 1;
    }
    if (suffixBytes(firstKept) > RC_HISTORY_PAGE_MAX_BYTES) {
        // Only the newest message is left and it still does not fit: keep
        // shortening its own string fields so the page always makes progress.
        const newestIndex = bounded.length - 1;
        const shrunk = shrinkMessageToBytes(bounded[newestIndex], RC_HISTORY_PAGE_MAX_BYTES, notice);
        encoded[newestIndex] = shrunk.json;
        sizes[newestIndex] = Buffer.byteLength(shrunk.json, 'utf8');
        truncatedFields += shrunk.truncatedFields;
    }
    const kept = bounded.slice(firstKept);
    const keptEncoded = encoded.slice(firstKept);
    const messagesJson = `[${keptEncoded.join(',')}]`;
    return {
        messages: kept,
        messagesJson,
        bytes: Buffer.byteLength(messagesJson, 'utf8'),
        truncatedFields,
        droppedMessages: firstKept,
    };
}
/** Tool-result / tool-argument wire keys, snake_case plus the camelCase alias. */
const RC_HISTORY_TOOL_FIELD_KEYS = [
    'tool_call_result_data',
    'toolCallResultData',
    'tool_call_args',
    'toolCallArgs',
];
/**
 * Tool arguments are consumed as JSON on the phone
 * (`parseToolCallArgsJson` in packages/ui), so cutting them on a byte
 * boundary would leave an unparseable value and an empty tool card. These
 * two keys are shortened inside their structure instead.
 */
const RC_HISTORY_JSON_FIELD_KEYS = new Set(['tool_call_args', 'toolCallArgs']);
function truncateMessageToolFields(message, notice) {
    if (!isPayload(message))
        return { message, truncatedFields: 0 };
    const toolCallsKey = Array.isArray(message.tool_calls)
        ? 'tool_calls'
        : Array.isArray(message.toolCalls)
            ? 'toolCalls'
            : undefined;
    if (!toolCallsKey)
        return { message, truncatedFields: 0 };
    const toolCalls = message[toolCallsKey];
    let truncatedFields = 0;
    let changed = false;
    const boundedToolCalls = toolCalls.map((call) => {
        if (!isPayload(call))
            return call;
        let next = call;
        for (const key of RC_HISTORY_TOOL_FIELD_KEYS) {
            const value = next[key];
            if (typeof value !== 'string')
                continue;
            const bytes = Buffer.byteLength(value, 'utf8');
            if (bytes <= RC_HISTORY_TOOL_FIELD_MAX_BYTES)
                continue;
            if (next === call)
                next = { ...call };
            const structured = RC_HISTORY_JSON_FIELD_KEYS.has(key)
                ? truncateJsonValueToBytes(value, RC_HISTORY_TOOL_FIELD_MAX_BYTES, notice)
                : undefined;
            next[key] =
                structured ??
                    truncateMiddleToBytes(value, RC_HISTORY_TOOL_FIELD_MAX_BYTES, notice(bytes), RC_HISTORY_TOOL_FIELD_HEAD_BYTES);
            truncatedFields += 1;
            changed = true;
        }
        return next;
    });
    if (!changed)
        return { message, truncatedFields: 0 };
    return {
        message: { ...message, [toolCallsKey]: boundedToolCalls },
        truncatedFields,
    };
}
/**
 * Shorten the over-long string values inside a JSON tool-argument payload and
 * return it re-encoded, so the phone still parses it as JSON.
 *
 * Only string values above RC_HISTORY_JSON_MIN_STRING_BYTES are candidates,
 * largest first, and each step aims at exactly the remaining excess. Non-string
 * fields and short strings (`file_path`, flags, ids) are copied through
 * untouched. When the structure itself cannot be squeezed under `limitBytes`
 * — a huge array of small objects — the value is returned still oversized
 * rather than corrupted: a slightly large page is recoverable, an unparseable
 * tool card is not.
 *
 * Every budget here is measured on the **encoded** form. JSON escaping inflates
 * a raw byte count — a newline costs two bytes, a quote or a backslash two —
 * so budgeting on raw bytes emptied the field whenever that inflation exceeded
 * the excess, leaving a card with a path and nothing else.
 *
 * Returns `undefined` when `value` is not a JSON object/array, which sends the
 * caller back to the plain head/tail byte truncation.
 */
function truncateJsonValueToBytes(value, limitBytes, notice) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object')
        return undefined;
    const root = parsed;
    const slots = collectStringSlots(root);
    let text = JSON.stringify(root) ?? value;
    while (Buffer.byteLength(text, 'utf8') > limitBytes) {
        let largest;
        let largestBytes = 0;
        for (const slot of slots) {
            const bytes = Buffer.byteLength(slot.value, 'utf8');
            if (bytes > largestBytes) {
                largest = slot;
                largestBytes = bytes;
            }
        }
        if (!largest || largestBytes <= RC_HISTORY_JSON_MIN_STRING_BYTES)
            break;
        const excess = Buffer.byteLength(text, 'utf8') - limitBytes;
        // The notice always reports the field's size as first parsed, so a field
        // shortened twice still tells the user how big the original was.
        const noticeText = notice(largest.originalBytes);
        // Shrinking this slot's encoded length by exactly `excess` lands the whole
        // payload on `limitBytes`.
        const targetEncoded = encodedStringLength(largest.value) - excess;
        const next = fitEncodedString(largest.value, targetEncoded, noticeText);
        largest.container[largest.key] = next;
        largest.value = next;
        text = JSON.stringify(root) ?? text;
    }
    return text;
}
/** Byte length of `value` once JSON-encoded, without the surrounding quotes. */
function encodedStringLength(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;
}
/**
 * Longest head + notice + tail form of `raw` that still encodes within
 * `targetEncoded`.
 *
 * Binary search over the raw byte budget: `truncateMiddleToBytes` grows
 * monotonically with the budget it is given, so "does this fit?" is monotone
 * and the search converges in ~log2(bytes) steps. When not even the notice
 * fits, the notice itself becomes the value — a card showing just "content
 * truncated, view it on desktop" still tells the user where the content went,
 * which is the whole reason this path exists. An empty string never is the
 * answer.
 */
function fitEncodedString(raw, targetEncoded, noticeText) {
    let low = 0;
    let high = Buffer.byteLength(raw, 'utf8');
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (encodedStringLength(truncateMiddleToBytes(raw, mid, noticeText)) <= targetEncoded) {
            low = mid;
        }
        else {
            high = mid - 1;
        }
    }
    return low > 0 ? truncateMiddleToBytes(raw, low, noticeText) : noticeText;
}
/**
 * Shorten one already-field-truncated message until it encodes to at most
 * `maxBytes`, largest string field first. Every step at least halves a field,
 * so the loop terminates; the result is a warn-and-accept fallback for a
 * message that is still oversized with all of its strings emptied (the audit
 * found none in three days of real data).
 */
function shrinkMessageToBytes(message, maxBytes, notice) {
    const slots = collectStringSlots(message);
    let json = JSON.stringify(message) ?? 'null';
    let truncatedFields = 0;
    while (Buffer.byteLength(json, 'utf8') > maxBytes) {
        let largest;
        let largestBytes = 0;
        for (const slot of slots) {
            const bytes = Buffer.byteLength(slot.value, 'utf8');
            if (bytes > largestBytes) {
                largest = slot;
                largestBytes = bytes;
            }
        }
        if (!largest)
            break;
        const shortened = truncateMiddleToBytes(largest.value, Math.floor(largestBytes / 2), notice(largest.originalBytes));
        // A field shorter than its own notice would grow instead of shrink.
        const next = Buffer.byteLength(shortened, 'utf8') < largestBytes ? shortened : '';
        largest.container[largest.key] = next;
        largest.value = next;
        truncatedFields += 1;
        json = JSON.stringify(message) ?? 'null';
    }
    return { json, truncatedFields };
}
/** Every string-valued slot reachable from `root` (JSON has no cycles). */
function collectStringSlots(root, out = []) {
    if (Array.isArray(root)) {
        for (const item of root)
            collectStringSlots(item, out);
        return out;
    }
    if (!isPayload(root))
        return out;
    for (const [key, value] of Object.entries(root)) {
        if (typeof value === 'string') {
            out.push({
                container: root,
                key,
                value,
                originalBytes: Buffer.byteLength(value, 'utf8'),
            });
        }
        else
            collectStringSlots(value, out);
    }
    return out;
}
/**
 * Keep `headBytes` from the front and the remainder of `limitBytes` from the
 * back, spliced with `notice`. Cuts land on UTF-8 character boundaries so a
 * multi-byte character is never split in half.
 */
function truncateMiddleToBytes(value, limitBytes, notice, headBytes = Math.floor((limitBytes * 3) / 4)) {
    if (limitBytes <= 0)
        return '';
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes <= limitBytes)
        return value;
    const buffer = Buffer.from(value, 'utf8');
    const head = sliceUtf8Head(buffer, Math.min(headBytes, limitBytes));
    const tail = sliceUtf8Tail(buffer, limitBytes - Math.min(headBytes, limitBytes));
    return `${head}${notice}${tail}`;
}
/** First `maxBytes` of `buffer`, backed off to the nearest character boundary. */
function sliceUtf8Head(buffer, maxBytes) {
    let end = Math.min(maxBytes, buffer.length);
    // 0b10xxxxxx marks a continuation byte, i.e. `end` sits mid-character.
    while (end > 0 && (buffer[end] & 0xc0) === 0x80)
        end -= 1;
    return buffer.toString('utf8', 0, end);
}
/** Last `maxBytes` of `buffer`, advanced to the nearest character boundary. */
function sliceUtf8Tail(buffer, maxBytes) {
    if (maxBytes <= 0)
        return '';
    let start = Math.max(0, buffer.length - maxBytes);
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80)
        start += 1;
    return buffer.toString('utf8', start);
}
/** Truncation notice wording, following the host application language. */
export function truncationNotice(locale) {
    const english = (locale ?? '').trim().toLowerCase().startsWith('en');
    return (originalBytes) => {
        const megabytes = (originalBytes / (1024 * 1024)).toFixed(1);
        return english
            ? `…[Content truncated, original ${megabytes} MB, view it on desktop]…`
            : `…[内容过长已截断，原始 ${megabytes} MB，请在桌面端查看]…`;
    };
}
/** Plain-object guard shared with the command router. */
export function isPayload(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
//# sourceMappingURL=session-history-bounds.js.map