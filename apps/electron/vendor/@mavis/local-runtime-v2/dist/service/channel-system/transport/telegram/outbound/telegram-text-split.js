/**
 * Telegram outbound text splitting.
 *
 * Telegram caps a single message: `sendRichMessage` rejects anything above
 * {@link TELEGRAM_RICH_TEXT_LIMIT} UTF-16 code units with
 * `400 RICH_MESSAGE_TEXT_TOO_LONG`, and the plain `sendMessage` fallback caps
 * at {@link TELEGRAM_PLAIN_TEXT_LIMIT}. A long agent reply therefore has to be
 * delivered as several messages, and this module owns that cut for both paths
 * so the rich path and its plain fallback stay consistent.
 *
 * Cut preference, best first:
 *   1. a paragraph break (blank line) — keeps prose blocks intact;
 *   2. a line break;
 *   3. a hard cut at the limit.
 *
 * Invariants the sender relies on:
 *   - every chunk is <= `limit`, the fence repair described below included;
 *   - concatenating the chunks in order reproduces the input, except for the
 *     fence lines this module adds;
 *   - no chunk is empty, and none is a code block with no code in it.
 *
 * A cut that lands inside a fenced code block would otherwise leave the
 * remainder of the reply rendered as code, so the current chunk is closed with
 * a fence line and the next chunk reopens the block with the original opening
 * line (e.g. ````python). Those added characters count against `limit`.
 */
/** `sendRichMessage` per-message cap, in UTF-16 code units. */
export const TELEGRAM_RICH_TEXT_LIMIT = 32768;
/** `sendMessage` per-message cap, in UTF-16 code units. */
export const TELEGRAM_PLAIN_TEXT_LIMIT = 4096;
/** Characters a Markdown fenced code block may be delimited with. */
const FENCE_CHARS = ['`', '~'];
/** Shortest run of {@link FENCE_CHARS} that delimits a fenced code block. */
const MIN_FENCE_LENGTH = 3;
/** Leading spaces a fence line may carry and still count as one. */
const MAX_FENCE_INDENT = 3;
/**
 * Split `text` into chunks of at most `limit` UTF-16 code units.
 *
 * Returns `[]` for empty input and `[text]` when it already fits, so callers can
 * treat a non-empty result as "send these in order".
 */
export function splitTelegramText(text, limit) {
    if (text.length === 0)
        return [];
    if (limit <= 0 || text.length <= limit)
        return [text];
    const chunks = [];
    let rest = text;
    let reopen = '';
    while (rest.length > 0) {
        // The reopened fence line is part of the next chunk, so it eats into that
        // chunk's budget.
        const budget = limit - reopen.length;
        if (budget < 1) {
            // Pathological limit (smaller than the fence we must re-emit): stop
            // honouring the cap rather than looping forever.
            chunks.push(reopen + rest);
            break;
        }
        if (rest.length <= budget) {
            chunks.push(reopen + rest);
            break;
        }
        const plan = planCut({ rest, prefix: reopen, budget });
        chunks.push(reopen + plan.head);
        reopen = plan.reopen;
        rest = plan.tail;
    }
    return chunks;
}
/**
 * Choose the boundary for one chunk, repairing it until the chunk is balanced,
 * within `budget`, and carries content.
 *
 * `context.prefix` is the fence line this chunk reopens with (empty for a
 * chunk that does not continue a block). Fence state is computed over
 * `prefix + rest` because that prefix already opens a block in the current
 * chunk — scanning `rest` alone would leave the chunk unbalanced.
 */
function planCut(context) {
    const { rest, prefix, budget } = context;
    const scoped = prefix + rest;
    let index = findCutIndex(rest, budget);
    let fence = openFenceAt(scoped, prefix.length + index);
    // Two repairs, both of which move the boundary and therefore change the
    // fence state, so they share one loop. Every branch either moves `index`
    // strictly or clears `fence`; the guard only bounds pathological input, and
    // the size check after the loop still holds if it ever trips.
    for (let guard = 0; guard < 16 && fence !== undefined; guard += 1) {
        // Worst case for the closing fence: a newline plus the marker. Reserving
        // that up front is what keeps "chunk <= limit" true — budgeting the
        // newline-free form overshoots by one as soon as the shrink below moves
        // the boundary off a line break.
        const reserve = fence.marker.length + 1;
        if (index + reserve > budget) {
            const shrunk = shrinkForFence(rest, budget - reserve, index);
            if (shrunk === undefined) {
                fence = undefined; // No room for a balanced fence under this limit.
                break;
            }
            index = shrunk;
        }
        else {
            const moved = avoidEmptyBlock(context, index, fence);
            if (moved === undefined)
                break;
            index = moved;
        }
        fence = openFenceAt(scoped, prefix.length + index);
    }
    const head = rest.slice(0, index);
    if (fence !== undefined && index + fence.marker.length + 1 > budget)
        fence = undefined;
    if (fence === undefined)
        return { head, tail: rest.slice(index), reopen: '' };
    return {
        head: head + closingFenceFor(head, fence.marker),
        tail: rest.slice(index),
        reopen: `${fence.marker.line}\n`,
    };
}
/**
 * Shrink `index` until the closing fence fits in `allowance`, or `undefined`
 * when no boundary below `index` leaves room for one — the limit is then too
 * small to keep the block balanced at all.
 */
function shrinkForFence(text, allowance, index) {
    const shrunk = allowance >= 1 ? findCutIndex(text, allowance) : 0;
    return shrunk >= 1 && shrunk < index ? shrunk : undefined;
}
/**
 * Move `index` so the chunk is not a code block with no code in it, or
 * `undefined` when it already carries content — or when the limit leaves no
 * room to move, in which case an empty block beats breaking the size cap.
 *
 * Stepping back in front of the opening fence line is preferred, so the block
 * starts in the next chunk. When that line already opens this chunk there is
 * nothing to step back to, so content is pulled in instead.
 */
function avoidEmptyBlock(context, index, fence) {
    const { rest, prefix, budget } = context;
    const bodyStart = blockBodyStart(fence, prefix);
    if (rest.slice(bodyStart, index).trim() !== '')
        return undefined;
    const back = fence.start - prefix.length;
    if (back >= 1 && rest.slice(0, back).trim() !== '')
        return back;
    const grown = contentCut(rest, index, budget - fence.marker.length - 1);
    return grown !== undefined && grown > index ? grown : undefined;
}
/**
 * Largest index <= `allowance` that ends a paragraph, else a line, else the
 * allowance itself. Never splits a surrogate pair and never returns 0, so the
 * caller always makes progress.
 */
function findCutIndex(text, allowance) {
    if (allowance >= text.length)
        return text.length;
    // Index `allowance` itself is a legal cut, so the search window includes it.
    const window = text.slice(0, allowance + 1);
    const paragraph = window.lastIndexOf('\n\n');
    if (paragraph >= 0 && paragraph + 2 <= allowance) {
        return avoidSurrogateSplit(text, paragraph + 2);
    }
    const newline = window.lastIndexOf('\n');
    if (newline >= 0 && newline + 1 <= allowance) {
        return avoidSurrogateSplit(text, newline + 1);
    }
    return avoidSurrogateSplit(text, Math.max(1, allowance));
}
/**
 * A cut in `(after, max]` that carries content: the natural break when one
 * sits past `after`, else the hard limit. `undefined` when `max` leaves no
 * room at all.
 */
function contentCut(text, after, max) {
    if (max <= after)
        return undefined;
    const natural = findCutIndex(text, max);
    return natural > after ? natural : avoidSurrogateSplit(text, max);
}
/** Move a boundary one unit left when it would cut an emoji / surrogate pair. */
function avoidSurrogateSplit(text, index) {
    if (index <= 0 || index >= text.length)
        return index;
    const before = text.charCodeAt(index - 1);
    const after = text.charCodeAt(index);
    const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
    if (!splitsPair)
        return index;
    return index - 1 >= 1 ? index - 1 : index;
}
/**
 * Offset inside the current chunk where the open block's code starts: past the
 * opening fence line when that line lives in this chunk, the very beginning
 * when the block was reopened by `prefix` (which already is that line).
 */
function blockBodyStart(fence, prefix) {
    if (fence.start < prefix.length)
        return 0;
    return fence.start - prefix.length + fence.marker.line.length + 1;
}
/**
 * The fenced code block still open at `index`, or `undefined` when the
 * boundary is outside every block. Only whole lines before the boundary are
 * considered; the line the boundary sits on is an unfinished line and never
 * counts as a fence.
 */
function openFenceAt(text, index) {
    const head = text.slice(0, index);
    // A trailing fragment is an unfinished line; a fence marker must be whole.
    const complete = head.endsWith('\n') ? head : head.slice(0, head.lastIndexOf('\n') + 1);
    if (complete === '')
        return undefined;
    let open;
    let offset = 0;
    for (const line of complete.split('\n')) {
        if (open === undefined) {
            const marker = parseOpenFence(line);
            if (marker !== undefined)
                open = { marker, start: offset };
        }
        else if (closesFence(line, open.marker)) {
            open = undefined;
        }
        offset += line.length + 1;
    }
    return open;
}
/**
 * Read `line` as a fence opener, or `undefined` when it is not one. Up to
 * {@link MAX_FENCE_INDENT} leading spaces are allowed, and the marker must be
 * at least {@link MIN_FENCE_LENGTH} characters long.
 *
 * A marker that repeats later on the same line is inline code, not a fence:
 * ```` ```foo``` is the command ```` opens no block.
 */
function parseOpenFence(line) {
    const body = line.slice(fenceIndent(line));
    const char = body[0];
    if (char === undefined || !FENCE_CHARS.includes(char)) {
        return undefined;
    }
    let length = 0;
    while (body[length] === char)
        length += 1;
    if (length < MIN_FENCE_LENGTH)
        return undefined;
    if (body.slice(length).includes(char))
        return undefined;
    return { line, char, length };
}
/**
 * Whether `line` closes a block opened by `open`: the same marker character,
 * at least as long as the opener, and nothing after it but whitespace.
 */
function closesFence(line, open) {
    const body = line.slice(fenceIndent(line));
    let length = 0;
    while (body[length] === open.char)
        length += 1;
    if (length < open.length)
        return false;
    return body.slice(length).trim() === '';
}
/** Leading spaces of `line`, capped at {@link MAX_FENCE_INDENT}. */
function fenceIndent(line) {
    let indent = 0;
    while (indent < MAX_FENCE_INDENT && line[indent] === ' ')
        indent += 1;
    return indent;
}
/** Closing fence for `head`, reusing its trailing newline when present. */
function closingFenceFor(head, marker) {
    const fence = marker.char.repeat(marker.length);
    return head.endsWith('\n') ? fence : `\n${fence}`;
}
//# sourceMappingURL=telegram-text-split.js.map