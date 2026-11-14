import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { MEMORY_SUMMARY_FILE } from '../contracts.js';
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
/**
 * 磁盘摘要与基线摘要做同一个编辑(§5.18)：先改磁盘，再以基线行当前内容为条件更新基线。
 * 基线做同样的编辑而不是抄磁盘内容，用户在上次整理后的手改才保持"相对基线的修改"身份。
 * `requireBoth` 时两侧任一缺失就不动手（写入请求行）；否则缺哪侧跳过哪侧（删除请求行）。
 * 调用方必须已持有 scope 互斥区。
 */
export async function editSummaryAndBaseline(deps, scopeKey, edit, options = {}) {
    const baseline = (await deps.repository.listBaselineFiles(scopeKey)).find((file) => file.fileName === MEMORY_SUMMARY_FILE);
    if (options.requireBoth && !baseline)
        return { status: 'missing', reason: 'no-baseline-summary' };
    const current = await deps.fileStore.readMemorySummary(scopeKey);
    if (options.requireBoth && current === undefined)
        return { status: 'missing', reason: 'summary-missing' };
    const onDisk = editOrKeep(current, edit);
    if (onDisk.status === 'rejected')
        return { status: 'rejected', side: 'disk', reason: onDisk.reason };
    const onBaseline = editOrKeep(baseline?.content, edit);
    if (onDisk.status === 'changed')
        await deps.fileStore.writeMemorySummary(scopeKey, onDisk.markdown);
    return commitBaselineEdit(deps, scopeKey, baseline?.content, onBaseline);
}
function editOrKeep(markdown, edit) {
    return markdown === undefined ? { status: 'unchanged' } : edit(markdown);
}
/** 以基线行当前内容为条件写回；被并发改写时返回 baseline-stale，不覆盖。 */
async function commitBaselineEdit(deps, scopeKey, expectedContent, onBaseline) {
    if (onBaseline.status === 'rejected')
        return { status: 'rejected', side: 'baseline', reason: onBaseline.reason };
    if (onBaseline.status === 'unchanged' || expectedContent === undefined)
        return { status: 'ok' };
    const committed = await deps.repository.updateBaselineSummary({
        scopeKey,
        expectedContent,
        content: onBaseline.markdown,
        updatedAtMs: deps.nowMs(),
    });
    return committed === 'committed'
        ? { status: 'ok' }
        : { status: 'baseline-stale', reason: committed };
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