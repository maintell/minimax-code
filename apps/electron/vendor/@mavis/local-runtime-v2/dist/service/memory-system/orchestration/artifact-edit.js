/**
 * MEMORY.md / memory_summary.md 的程序级解析与直编工具（§5.6、§5.8）。
 *
 * 产物条目的合同形状（§6.2）：`- ` 起头的列表项 + 缩进续行，其中必须有一行
 * 以 `来源: ` 起头列出来源 Session。程序依赖该前缀做确定性退出与直编。
 */
import { formatProductTime } from '@mavis/shared/product-time';
const SOURCE_LINE_RE = /^\s*来源:\s*(.+)$/u;
/** 把产物按行切成「条目块 / 其它行」序列，供删除与重组。 */
function splitEntries(markdown) {
    const lines = markdown.split('\n');
    const parts = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (!/^- /u.test(line)) {
            parts.push(line);
            index += 1;
            continue;
        }
        const block = [line];
        index += 1;
        while (index < lines.length && /^\s+\S/u.test(lines[index])) {
            block.push(lines[index]);
            index += 1;
        }
        parts.push({ lines: block, sourceSessionIds: parseSourceIds(block) });
    }
    return parts;
}
function parseSourceIds(block) {
    for (const line of block) {
        const match = SOURCE_LINE_RE.exec(line);
        if (!match)
            continue;
        const meta = match[1];
        // "来源: <id>[, <id>…] · <project?> · <date> · keywords: …" —— 第一个 `·` 前是 id 列表。
        const idsPart = meta.split('·')[0] ?? '';
        return idsPart
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }
    return [];
}
/** 产物中出现过的全部来源 Session（§5.6 changes 合成的 removed 依据）。 */
export function listArtifactSourceIds(markdown) {
    const ids = new Set();
    for (const part of splitEntries(markdown)) {
        if (typeof part === 'string')
            continue;
        for (const id of part.sourceSessionIds)
            ids.add(id);
    }
    return ids;
}
/** 来源时间取采集记录，模型保留的毫秒字段与旧日期在发布前统一渲染。 */
export function formatArtifactSourceDates(markdown, capturedAtBySession, timeZone) {
    return splitEntries(markdown)
        .flatMap((part) => {
        if (typeof part === 'string')
            return [part];
        const timestamps = part.sourceSessionIds
            .map((id) => capturedAtBySession.get(id))
            .filter((value) => value !== undefined);
        if (timestamps.length === 0)
            return part.lines;
        const date = formatProductTime(Math.max(...timestamps), {
            preset: 'audit-date',
            locale: 'zh-CN',
            timeZone,
        });
        if (!date)
            return part.lines;
        return part.lines.map((line) => {
            if (!SOURCE_LINE_RE.test(line))
                return line;
            const [source = '', ...fields] = line.split('·');
            const metadata = fields.map((field) => field.trim());
            const withoutDate = metadata.filter((field) => !/^(?:captured_at_ms:\s*\d+|\d{4}-\d{2}-\d{2})$/u.test(field));
            const keywordsIndex = withoutDate.findIndex((field) => field.startsWith('keywords:'));
            withoutDate.splice(keywordsIndex < 0 ? withoutDate.length : keywordsIndex, 0, date);
            return `${source.trimEnd()} · ${withoutDate.join(' · ')}`;
        });
    })
        .join('\n');
}
/** 删除来源标注命中给定集合的条目块（退出清理与整会话遗忘共用，§5.8）。 */
export function removeEntriesBySource(markdown, sessionIds) {
    if (sessionIds.size === 0)
        return { markdown, removed: 0 };
    let removed = 0;
    const out = [];
    for (const part of splitEntries(markdown)) {
        if (typeof part === 'string') {
            out.push(part);
            continue;
        }
        if (part.sourceSessionIds.some((id) => sessionIds.has(id))) {
            removed += 1;
            continue;
        }
        out.push(...part.lines);
    }
    return { markdown: collapseBlankRuns(out).join('\n'), removed };
}
/** 行级逐字匹配删除（部分内容遗忘的直编，§5.8）；命中行随其缩进续行一并删除。 */
export function removeLinesMatching(markdown, targetText) {
    const needle = targetText.trim();
    if (needle.length === 0)
        return { markdown, removed: 0 };
    let removed = 0;
    const out = [];
    for (const part of splitEntries(markdown)) {
        if (typeof part === 'string') {
            if (part.trim() === needle || part.includes(needle)) {
                removed += 1;
                continue;
            }
            out.push(part);
            continue;
        }
        if (part.lines.some((line) => line.includes(needle))) {
            removed += 1;
            continue;
        }
        out.push(...part.lines);
    }
    return { markdown: collapseBlankRuns(out).join('\n'), removed };
}
/** 简单行级 diff（公共前后缀裁剪），供 changes.md 展示；相同输入产生相同输出。 */
export function simpleLineDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    let start = 0;
    while (start < oldLines.length &&
        start < newLines.length &&
        oldLines[start] === newLines[start]) {
        start += 1;
    }
    let oldEnd = oldLines.length;
    let newEnd = newLines.length;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
        oldEnd -= 1;
        newEnd -= 1;
    }
    const parts = [];
    for (const line of oldLines.slice(start, oldEnd))
        parts.push(`- ${line}`);
    for (const line of newLines.slice(start, newEnd))
        parts.push(`+ ${line}`);
    return parts.join('\n');
}
/** 连续空行折叠为一行，避免直编后留下空洞。 */
function collapseBlankRuns(lines) {
    const out = [];
    for (const line of lines) {
        if (line.trim() === '' && out[out.length - 1]?.trim() === '')
            continue;
        out.push(line);
    }
    return out;
}
//# sourceMappingURL=artifact-edit.js.map