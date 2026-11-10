import { mapMarkdownOutsideProtected } from './asset-markup/markdown-protected.js';
/**
 * File backfill can produce the same link beside an existing citation. Only
 * identical labels AND targets separated by horizontal whitespace are redundant:
 * different locations, prose, paragraphs and table cells must stay intact.
 * Shared by answer repair and display/history projection; no source inference.
 */
export function collapseAdjacentDuplicateFileCitations(markdown) {
    if (!markdown.includes('#mavis-source=file:'))
        return markdown;
    return mapMarkdownOutsideProtected(markdown, (text) => {
        const citationPattern = (() => {
            try {
                // eslint-disable-next-line prefer-regex-literals -- Old WebKit must catch unsupported syntax at runtime.
                return new RegExp('(?<![!\\\\])\\[([^[\\]\\n]+)\\]\\([ \\t]*(#mavis-source=file:[A-Za-z0-9_-]+)[ \\t]*\\)', 'gu');
            }
            catch {
                return /\[([^[\]\n]+)\]\([ \t]*(#mavis-source=file:[A-Za-z0-9_-]+)[ \t]*\)/gu;
            }
        })();
        let previous;
        let cursor = 0;
        const parts = [];
        for (const match of text.matchAll(citationPattern)) {
            const start = match.index;
            // Check the preceding character without lookbehind for iOS < 16.4.
            if (start > 0 && /[!\\]/u.test(text.charAt(start - 1)))
                continue;
            const end = start + match[0].length;
            const lineStart = text.lastIndexOf('\n', start - 1) + 1;
            // Be conservative around indented code (and deeply nested lists).
            if (text.startsWith('    ', lineStart) || text[lineStart] === '\t') {
                previous = undefined;
                continue;
            }
            const label = match[1] ?? '';
            const href = match[2] ?? '';
            if (previous?.label === label &&
                previous.href === href &&
                /^[ \t]*$/u.test(text.slice(previous.end, start))) {
                parts.push(text.slice(cursor, previous.end));
                cursor = end;
            }
            previous = { label, href, end };
        }
        parts.push(text.slice(cursor));
        return parts.join('');
    });
}
//# sourceMappingURL=file-source-citation.js.map