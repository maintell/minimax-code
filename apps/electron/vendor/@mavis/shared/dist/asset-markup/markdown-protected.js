/**
 * Markdown protected-range helpers (code blocks and inline code spans).
 *
 * Shared by asset parsing and runtime rewriting. The UI module re-exports
 * from here so the same code regions stay opaque across both paths.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function mayContainProtectedMarkdown(markdown) {
    return (markdown.includes('`') ||
        markdown.includes('~~~') ||
        markdown.includes('    ') ||
        markdown.includes('\t'));
}
function replaceNative(markdown, pattern, replacement) {
    if (typeof replacement === 'function') {
        return markdown.replace(pattern, (match, ...args) => replacement(match, ...args));
    }
    return markdown.replace(pattern, replacement);
}
function mergeRanges(ranges) {
    if (ranges.length <= 1)
        return ranges;
    const sorted = ranges
        .filter((range) => range.end > range.start)
        .sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const range of sorted) {
        const previous = merged[merged.length - 1];
        if (!previous || range.start > previous.end) {
            merged.push({ ...range });
            continue;
        }
        previous.end = Math.max(previous.end, range.end);
    }
    return merged;
}
function findFencedCodeRanges(markdown) {
    const ranges = [];
    let lineStart = 0;
    while (lineStart < markdown.length) {
        const newlineIndex = markdown.indexOf('\n', lineStart);
        const lineEnd = newlineIndex === -1 ? markdown.length : newlineIndex;
        const lineEndWithNewline = newlineIndex === -1 ? markdown.length : newlineIndex + 1;
        const line = markdown.slice(lineStart, lineEnd);
        const opener = /^( {0,3})(`{3,}|~{3,})/.exec(line);
        if (!opener) {
            lineStart = lineEndWithNewline;
            continue;
        }
        const marker = opener[2] ?? '';
        const fenceChar = marker[0] ?? '';
        if (!marker || !fenceChar) {
            lineStart = lineEndWithNewline;
            continue;
        }
        const minFenceLength = marker.length;
        const closeRe = new RegExp(`^ {0,3}${escapeRegExp(fenceChar)}{${minFenceLength},}\\s*$`);
        let scanStart = lineEndWithNewline;
        let rangeEnd = markdown.length;
        while (scanStart < markdown.length) {
            const scanNewlineIndex = markdown.indexOf('\n', scanStart);
            const scanLineEnd = scanNewlineIndex === -1 ? markdown.length : scanNewlineIndex;
            const scanLineEndWithNewline = scanNewlineIndex === -1 ? markdown.length : scanNewlineIndex + 1;
            const scanLine = markdown.slice(scanStart, scanLineEnd);
            if (closeRe.test(scanLine)) {
                rangeEnd = scanLineEndWithNewline;
                break;
            }
            scanStart = scanLineEndWithNewline;
        }
        ranges.push({ start: lineStart, end: rangeEnd });
        lineStart = rangeEnd;
    }
    return ranges;
}
function findBlockCodeRanges(markdown) {
    // Inline backticks alone cannot introduce a block. Keep the full CommonMark
    // parser for fences/indentation, including nested lists and blockquotes.
    if (!/`{3}|~{3}| {4}|\t/.test(markdown))
        return [];
    const ranges = [];
    const nodes = [...fromMarkdown(markdown).children];
    for (const node of nodes) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) {
            if (node.type === 'code') {
                ranges.push({ start, end });
            }
            else if (node.type === 'html') {
                // Delivery wrappers are raw HTML to CommonMark, but historically
                // their fenced examples are also protected from asset processing.
                for (const range of findFencedCodeRanges(markdown.slice(start, end))) {
                    ranges.push({ start: start + range.start, end: start + range.end });
                }
            }
        }
        if ('children' in node) {
            for (const child of node.children)
                nodes.push(child);
        }
    }
    return mergeRanges(ranges);
}
function findInlineCodeRanges(markdown, fencedRanges) {
    const ranges = [];
    let cursor = 0;
    const scanText = (start, end) => {
        let index = start;
        while (index < end) {
            if (markdown[index] !== '`') {
                index += 1;
                continue;
            }
            const markerStart = index;
            let markerEnd = index + 1;
            while (markerEnd < end && markdown[markerEnd] === '`') {
                markerEnd += 1;
            }
            const marker = markdown.slice(markerStart, markerEnd);
            const closeIndex = markdown.indexOf(marker, markerEnd);
            if (closeIndex === -1 || closeIndex >= end) {
                index = markerEnd;
                continue;
            }
            ranges.push({ start: markerStart, end: closeIndex + marker.length });
            index = closeIndex + marker.length;
        }
    };
    for (const range of fencedRanges) {
        if (cursor < range.start) {
            scanText(cursor, range.start);
        }
        cursor = Math.max(cursor, range.end);
    }
    if (cursor < markdown.length) {
        scanText(cursor, markdown.length);
    }
    return ranges;
}
export function findMarkdownProtectedRanges(markdown) {
    if (!mayContainProtectedMarkdown(markdown))
        return [];
    const blockRanges = findBlockCodeRanges(markdown);
    const inlineRanges = findInlineCodeRanges(markdown, blockRanges);
    return mergeRanges([...blockRanges, ...inlineRanges]);
}
export function isIndexInMarkdownProtectedRange(index, ranges) {
    return ranges.some((range) => index >= range.start && index < range.end);
}
function getReplaceOffset(args) {
    const lastArg = args.at(-1);
    const offsetArg = lastArg !== null && typeof lastArg === 'object' ? args.at(-3) : args.at(-2);
    return typeof offsetArg === 'number' ? offsetArg : null;
}
/** A single transformation pipeline owns its ranges; no text survives across calls. */
export class MarkdownProtectedText {
    text;
    ranges;
    constructor(text) {
        this.text = text;
    }
    get value() {
        return this.text;
    }
    protectedRanges() {
        this.ranges ??= findMarkdownProtectedRanges(this.text);
        return this.ranges;
    }
    update(text) {
        if (text !== this.text) {
            this.text = text;
            // A rewrite can move offsets or introduce code syntax. Reparse lazily
            // before the next operation instead of carrying stale ranges forward.
            this.ranges = undefined;
        }
        return this;
    }
    map(transform) {
        const next = splitProtectedSegments(this.text, this.protectedRanges())
            .map((segment) => segment.type === 'protected' ? segment.content : transform(segment.content))
            .join('');
        return this.update(next);
    }
    replace(pattern, replacement) {
        pattern.lastIndex = 0;
        const hasMatch = pattern.test(this.text);
        pattern.lastIndex = 0;
        if (!hasMatch)
            return this;
        const ranges = this.protectedRanges();
        if (ranges.length === 0) {
            return this.update(replaceNative(this.text, pattern, replacement));
        }
        const next = this.text.replace(pattern, (match, ...args) => {
            const offset = getReplaceOffset(args);
            if (offset !== null && isIndexInMarkdownProtectedRange(offset, ranges))
                return match;
            return typeof replacement === 'function' ? replacement(match, ...args) : replacement;
        });
        return this.update(next);
    }
}
export function replaceMarkdownOutsideProtected(markdown, pattern, replacement) {
    return new MarkdownProtectedText(markdown).replace(pattern, replacement).value;
}
export function splitMarkdownProtectedSegments(markdown) {
    return splitProtectedSegments(markdown, findMarkdownProtectedRanges(markdown));
}
function splitProtectedSegments(markdown, ranges) {
    if (ranges.length === 0)
        return [{ type: 'text', content: markdown }];
    const segments = [];
    let cursor = 0;
    for (const range of ranges) {
        if (cursor < range.start) {
            segments.push({ type: 'text', content: markdown.slice(cursor, range.start) });
        }
        segments.push({ type: 'protected', content: markdown.slice(range.start, range.end) });
        cursor = range.end;
    }
    if (cursor < markdown.length) {
        segments.push({ type: 'text', content: markdown.slice(cursor) });
    }
    return segments.length > 0 ? segments : [{ type: 'text', content: markdown }];
}
export function mapMarkdownOutsideProtected(markdown, transform) {
    return new MarkdownProtectedText(markdown).map(transform).value;
}
//# sourceMappingURL=markdown-protected.js.map