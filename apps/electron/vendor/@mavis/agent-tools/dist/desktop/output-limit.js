export const DESKTOP_GREP_CONTENT_MAX_BYTES = 16 * 1024;
export const DESKTOP_READ_TEXT_MAX_BYTES = 24 * 1024;
export const DESKTOP_BASH_MAX_BYTES = 24 * 1024;
// Leave room for exit/timing receipts and the readable output reference.
export const DESKTOP_BASH_PREVIEW_BYTES = DESKTOP_BASH_MAX_BYTES - 2048;
export function limitDesktopPrefixLines(text, options) {
    const originalBytes = options.originalBytes ?? byteLength(text);
    const inputLines = splitBodyLines(text);
    if (originalBytes <= options.maxBytes) {
        return { text, returnedBodyLines: inputLines.length };
    }
    let bestText = fitUtf8Prefix(options.notice({ originalBytes, returnedBodyLines: 0, retainedLines: [] }), options.maxBytes);
    let returnedBodyLines = 0;
    for (let count = 1; count <= inputLines.length; count += 1) {
        const body = inputLines.slice(0, count).join('\n');
        const retainedLines = inputLines.slice(0, count);
        const notice = options.notice({ originalBytes, returnedBodyLines: count, retainedLines });
        const candidate = joinBodyAndNotice(body, notice);
        if (byteLength(candidate) > options.maxBytes)
            break;
        bestText = candidate;
        returnedBodyLines = count;
    }
    return buildLimitedResult(bestText, 'prefix_lines', originalBytes, options.maxBytes, returnedBodyLines);
}
export function limitDesktopHeadTailLines(text, options) {
    const originalBytes = byteLength(text);
    const inputLines = splitBodyLines(text);
    if (originalBytes <= options.maxBytes) {
        return { text, returnedBodyLines: inputLines.length };
    }
    const notice = fitUtf8Prefix(options.notice({ originalBytes, returnedBodyLines: 0, retainedLines: [] }), options.maxBytes);
    const separatorBytes = byteLength('\n\n') * 2;
    const bodyBudget = Math.max(0, options.maxBytes - byteLength(notice) - separatorBytes);
    const headBudget = Math.floor(bodyBudget * 0.45);
    const tailBudget = bodyBudget - headBudget;
    const wholeHead = takeWholeLinesFromStart(inputLines, headBudget);
    const oversizedHead = wholeHead.count === 0 && byteLength(inputLines[0] ?? '') > headBudget
        ? fitUtf8Prefix(inputLines[0] ?? '', headBudget)
        : '';
    const head = oversizedHead ? { text: oversizedHead, count: 0 } : wholeHead;
    const tailInput = inputLines.slice(wholeHead.count);
    const wholeTail = takeWholeLinesFromEnd(tailInput, tailBudget);
    const boundaryIndex = tailInput.length - wholeTail.count - 1;
    const oversizedTailLine = boundaryIndex >= 0 ? (tailInput[boundaryIndex] ?? '') : '';
    const tailJoinBytes = wholeTail.text.length > 0 ? byteLength('\n') : 0;
    const tailFragmentBudget = Math.max(0, tailBudget - byteLength(wholeTail.text) - tailJoinBytes);
    const oversizedTail = byteLength(oversizedTailLine) > tailBudget && tailFragmentBudget > 0
        ? fitUtf8Suffix(oversizedTailLine, tailFragmentBudget)
        : '';
    const tail = oversizedTail
        ? {
            text: wholeTail.text ? `${oversizedTail}\n${wholeTail.text}` : oversizedTail,
            count: wholeTail.count,
        }
        : wholeTail;
    const pieces = [head.text, notice, tail.text].filter((piece) => piece.length > 0);
    let limitedText = pieces.join('\n\n');
    if (byteLength(limitedText) > options.maxBytes) {
        limitedText = fitUtf8Prefix(limitedText, options.maxBytes);
    }
    return buildLimitedResult(limitedText, 'head_tail_lines', originalBytes, options.maxBytes, wholeHead.count + wholeTail.count + (oversizedHead ? 1 : 0) + (oversizedTail ? 1 : 0));
}
export function applyDesktopTextLimit(result, limited) {
    if (!limited.truncation)
        return result;
    let replaced = false;
    const content = [];
    for (const block of result.content) {
        if (block.type !== 'text') {
            content.push(block);
            continue;
        }
        if (replaced)
            continue;
        replaced = true;
        content.push({ ...block, text: limited.text });
    }
    if (!replaced)
        content.unshift({ type: 'text', text: limited.text });
    const continuation = limited.truncation.continuation_hint
        ? createDesktopOutputContinuation({
            ...(limited.truncation.next_offset === undefined
                ? {}
                : { next_offset: limited.truncation.next_offset }),
            ...(limited.truncation.offset_unit === undefined
                ? {}
                : { offset_unit: limited.truncation.offset_unit }),
            continuation_hint: limited.truncation.continuation_hint,
        })
        : undefined;
    return {
        ...result,
        text: limited.text,
        content,
        details: {
            ...(result.details ?? {}),
            desktop_output_truncation: limited.truncation,
            ...(continuation ? { desktop_output_continuation: continuation } : {}),
        },
    };
}
export function createDesktopOutputContinuation(continuation) {
    return { has_more: true, ...continuation };
}
export function withDesktopOutputContinuation(limited, continuation) {
    if (!limited.truncation)
        return limited;
    return {
        ...limited,
        truncation: {
            ...limited.truncation,
            ...continuation,
        },
    };
}
function buildLimitedResult(text, strategy, originalBytes, maxBytes, returnedBodyLines) {
    return {
        text,
        returnedBodyLines,
        truncation: {
            truncated: true,
            has_more: true,
            strategy,
            original_bytes: originalBytes,
            returned_bytes: byteLength(text),
            max_bytes: maxBytes,
        },
    };
}
function splitBodyLines(text) {
    const body = text.replace(/\n+$/, '');
    return body ? body.split('\n') : [];
}
function takeWholeLinesFromStart(lines, maxBytes) {
    const kept = [];
    for (const line of lines) {
        const candidate = [...kept, line].join('\n');
        if (byteLength(candidate) > maxBytes)
            break;
        kept.push(line);
    }
    return { text: kept.join('\n'), count: kept.length };
}
function takeWholeLinesFromEnd(lines, maxBytes) {
    const kept = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        const candidate = [line, ...kept].join('\n');
        if (byteLength(candidate) > maxBytes)
            break;
        kept.unshift(line);
    }
    return { text: kept.join('\n'), count: kept.length };
}
function joinBodyAndNotice(body, notice) {
    if (!body)
        return notice;
    if (!notice)
        return body;
    return `${body}\n\n${notice}`;
}
function fitUtf8Prefix(text, maxBytes) {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= maxBytes)
        return text;
    let end = Math.max(0, maxBytes);
    while (end > 0 && isUtf8Continuation(buffer[end]))
        end -= 1;
    return buffer.subarray(0, end).toString('utf8');
}
function fitUtf8Suffix(text, maxBytes) {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= maxBytes)
        return text;
    let start = Math.max(0, buffer.length - maxBytes);
    while (start < buffer.length && isUtf8Continuation(buffer[start]))
        start += 1;
    return buffer.subarray(start).toString('utf8');
}
function isUtf8Continuation(byte) {
    return byte !== undefined && (byte & 0xc0) === 0x80;
}
function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}
//# sourceMappingURL=output-limit.js.map