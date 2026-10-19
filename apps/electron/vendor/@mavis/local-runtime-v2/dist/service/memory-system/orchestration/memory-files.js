import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { renderSessionMirror } from './session-doc.js';
const MAX_OUTPUT_TOKENS = 20_000;
const MAX_READ_LINES = 200;
const MAX_MATCHES = 200;
export function fileFailure(code, message) {
    return { status: 'failed', code, message };
}
/** 逻辑路径从根寻址，不把模型参数交给宿主路径解析器。 */
export function isMemoryPath(path, allowRoot = false) {
    if (typeof path !== 'string')
        return false;
    if (path === '')
        return allowRoot;
    return (!/[\\:\u0000-\u001f\u007f]/u.test(path) &&
        path.split('/').every((part) => part.length > 0 && !part.startsWith('.')));
}
export function noteFilePath(sessionId) {
    return `extensions/ad_hoc/notes/${sessionId}.md`;
}
export function renderStateMirror(state) {
    return renderSessionMirror(state, state.content ?? '');
}
function outputFits(value, maxBytes = Number.POSITIVE_INFINITY) {
    const json = JSON.stringify(value);
    return (Buffer.byteLength(json, 'utf8') <= maxBytes &&
        countTokens(json, { disallowedSpecial: new Set() }) <= MAX_OUTPUT_TOKENS);
}
/** 保留原始换行；末尾换行不额外制造空行。 */
function fileLines(content) {
    return content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}
export function readFileWindow(path, content, offset = 1, maxBytes) {
    const lines = fileLines(content);
    if (!Number.isSafeInteger(offset) || offset < 1 || offset > Math.max(1, lines.length)) {
        return fileFailure('out-of-range', 'Choose an existing positive line number.');
    }
    const start = offset - 1;
    const resultAt = (end) => ({
        path,
        start_line_number: offset,
        content: lines.slice(start, end).join(''),
        next_line_offset: end < lines.length ? end + 1 : null,
    });
    let end = Math.min(lines.length, start + MAX_READ_LINES);
    while (end > start && !outputFits(resultAt(end), maxBytes))
        end--;
    if ((end === start && start < lines.length) || !outputFits(resultAt(end), maxBytes)) {
        return fileFailure('out-of-range', 'This line is too long for one response. Choose another line.');
    }
    return { status: 'ok', result: resultAt(end) };
}
/** 与既有记忆搜索保持同一 NFKC 和大小写处理顺序。 */
export function searchFiles(files, query) {
    const needle = query.trim().normalize('NFKC').toLowerCase();
    const matches = [];
    for (const [path, content] of files) {
        const lines = fileLines(content);
        for (let i = 0; i < lines.length; i++) {
            if (!lines[i].normalize('NFKC').toLowerCase().includes(needle))
                continue;
            if (matches.length === MAX_MATCHES)
                return { matches, truncated: true };
            const match = {
                path,
                line_number: i + 1,
                excerpt: lines.slice(Math.max(0, i - 2), i + 3).join(''),
            };
            if (!outputFits({ matches: [...matches, match], truncated: false })) {
                return {
                    matches: matches.length ? matches : [truncateSearchMatch(match)],
                    truncated: true,
                };
            }
            matches.push(match);
        }
    }
    return { matches, truncated: false };
}
function truncateSearchMatch(match) {
    const chars = Array.from(match.excerpt);
    const resultAt = (end) => ({
        ...match,
        excerpt: `${chars.slice(0, end).join('')}\n[excerpt truncated]`,
    });
    let low = 0;
    let high = chars.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (outputFits({ matches: [resultAt(mid)], truncated: true }))
            low = mid;
        else
            high = mid - 1;
    }
    return resultAt(low);
}
//# sourceMappingURL=memory-files.js.map