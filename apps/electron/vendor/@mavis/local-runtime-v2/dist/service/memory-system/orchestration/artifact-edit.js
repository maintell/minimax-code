/**
 * MEMORY.md / memory_summary.md 的程序级解析与直编工具（§5.6、§5.8）。
 *
 * 产物条目的合同形状（§6.2）：`- ` 起头的列表项 + 缩进续行，其中必须有一行
 * 以 `来源: ` 起头列出来源 Session。程序依赖该前缀做确定性退出与直编。
 */
import { formatProductTime } from '@mavis/shared/product-time';
import { countTokens as countO200kBaseTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { REDACTION_MARK, redactMemorySecrets } from '../secret-redactor.js';
import { noteFilePath } from './memory-files.js';
const SOURCE_LINE_RE = /^\s*来源:\s*(.+)$/u;
/** 把产物按行切成「条目块 / 其它行」序列，供删除、重组与准入核对。 */
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
const PREFERENCE_HEADING = '## 用户偏好';
const SEARCH_KEY_RE = /\[搜:([^\]]+)\]/gu;
const GLOBAL_SCOPE_RE = /适用[:：]\s*全局/u;
const QUOTE_RE = /["“「]([^"”」\n]{4,})["”」]/gu;
const SUPERSEDED_RE = /^-\s*~~/u;
const SECTION_BOUNDARY_RE = /^#{1,2} /u;
/** V1 记忆迁移生成的会话文档 ID 前缀（legacy-migration-service `deriveLegacySessionId`）。 */
const LEGACY_SOURCE_PREFIX = 'legacy-';
export function pruneUnverifiedSummaryPreferences(input) {
    const lines = input.summaryMarkdown.split('\n');
    const section = findSection(lines, PREFERENCE_HEADING);
    if (!section)
        return { markdown: input.summaryMarkdown, removed: 0 };
    const entries = currentIndexEntries(input.indexMarkdown);
    const kept = [];
    let removed = 0;
    for (const part of splitEntries(lines.slice(section.start + 1, section.end).join('\n'))) {
        if (typeof part === 'string') {
            kept.push(part);
        }
        else if (part.lines.every((line) => input.protectedLines.has(line)) ||
            isVerified(part.lines.join('\n'), entries, input)) {
            kept.push(...part.lines);
        }
        else {
            removed += 1;
        }
    }
    if (removed === 0)
        return { markdown: input.summaryMarkdown, removed };
    const markdown = [
        ...lines.slice(0, section.start + 1),
        ...kept,
        ...lines.slice(section.end),
    ].join('\n');
    return { markdown, removed };
}
/** 摘要「用户偏好」区的正文行（不含标题），换行先统一为 LF。 */
export function summaryPreferenceLines(summaryMarkdown) {
    const lines = summaryMarkdown.replace(/\r\n?/gu, '\n').split('\n');
    const section = findSection(lines, PREFERENCE_HEADING);
    return section ? lines.slice(section.start + 1, section.end) : [];
}
/** 每个搜索键都必须唯一命中一条当前有效条目，且该条目是有原话来源的全局偏好。 */
function isVerified(line, entries, evidence) {
    const keys = [...line.matchAll(SEARCH_KEY_RE)].map((match) => match[1]);
    if (keys.length === 0)
        return false;
    return keys.every((key) => {
        const matched = entries.filter((entry) => entry.lines.some((text) => text.includes(key)));
        return matched.length === 1 && isSourcedGlobalPreference(matched[0], evidence);
    });
}
function isSourcedGlobalPreference(entry, evidence) {
    const text = entry.lines.join('\n');
    if (!GLOBAL_SCOPE_RE.test(text))
        return false;
    const quotes = extractQuotes(text);
    return entry.sourceSessionIds.some((id) => {
        const passages = evidencePassages(id, evidence);
        return quotes.some((quote) => passages.some((passage) => passage.includes(quote)));
    });
}
/** 来源中可作为原话依据的正文：会话文档取「用户偏好」条目，note 取去掉引用符号的全文。 */
function evidencePassages(sourceId, evidence) {
    if (sourceId.startsWith(LEGACY_SOURCE_PREFIX))
        return [];
    const note = evidence.noteDocs.get(sourceId);
    if (note !== undefined)
        return [normalize(note.replace(/^>\s?/gmu, ''))];
    const doc = evidence.sessionDocs.get(sourceId);
    return doc === undefined ? [] : preferenceItems(doc);
}
/** 当前有效条目：带来源标注且未被标为已替代。 */
function currentIndexEntries(indexMarkdown) {
    return splitEntries(indexMarkdown).filter((part) => typeof part !== 'string' &&
        part.sourceSessionIds.length > 0 &&
        !SUPERSEDED_RE.test(part.lines[0] ?? ''));
}
/** 会话文档「用户偏好」小节的全部条目（范围由模型判断，不在这里过滤），已归一化。 */
function preferenceItems(doc) {
    const lines = doc.split('\n');
    const section = findSection(lines, PREFERENCE_HEADING);
    if (!section)
        return [];
    return splitEntries(lines.slice(section.start + 1, section.end).join('\n'))
        .filter((part) => typeof part !== 'string')
        .map((part) => normalize(part.lines.join('\n')));
}
/** 标题行下标与小节结束下标（下一个一、二级标题或文末）；标题不存在时返回 undefined。 */
function findSection(lines, heading) {
    const start = lines.findIndex((line) => line.trim() === heading);
    if (start < 0)
        return undefined;
    const next = lines.findIndex((line, index) => index > start && SECTION_BOUNDARY_RE.test(line));
    return { start, end: next < 0 ? lines.length : next };
}
/** 小节内最后一个非空行之后的位置；小节只有标题时紧跟标题。start 为 -1 时表示整份文件。 */
function sectionInsertAt(lines, section) {
    let at = section.end;
    while (at > section.start + 1 && lines[at - 1]?.trim() === '')
        at -= 1;
    return at;
}
/**
 * 把旧索引中来源包含缺失会话的条目块原样放回新索引（§5.6 INIT 补回）。条目块按旧索引顺序放进
 * 新索引里同名分节的末尾（分节范围与 findSection 相同），新索引没有该分节时在文件末尾补上分节标题；
 * 一个条目块有多个缺失来源时整块放回一次。块里的全部来源都在 restorable 里才放回：含有带遗忘规则
 * 或已退出准入集合的来源时跳过，免得把已遗忘、已删除或已排除会话的内容带回来。
 * restored / skipped 记录每个缺失会话放回与跳过的条目块数。
 */
export function restoreEntriesBySource(previousMarkdown, markdown, sources) {
    const { sections, restored, skipped } = collectRestoreBlocks(previousMarkdown, sources);
    let lines = markdown.split('\n');
    for (const [name, blocks] of sections)
        lines = insertIntoSection(lines, name, blocks);
    return { markdown: lines.join('\n'), restored, skipped };
}
/** 按旧索引顺序收集可放回的条目块，按所在分节标题分组；分节外的条目归入 undefined。 */
function collectRestoreBlocks(previousMarkdown, sources) {
    const restored = new Map([...sources.missing].map((id) => [id, 0]));
    const skipped = new Map([...sources.missing].map((id) => [id, 0]));
    const sections = new Map();
    let heading;
    for (const part of splitEntries(previousMarkdown)) {
        if (typeof part === 'string') {
            if (SECTION_BOUNDARY_RE.test(part))
                heading = part.trim();
            continue;
        }
        const hits = part.sourceSessionIds.filter((id) => sources.missing.has(id));
        const allowed = part.sourceSessionIds.every((id) => sources.restorable.has(id));
        const counts = allowed ? restored : skipped;
        for (const id of hits)
            counts.set(id, (counts.get(id) ?? 0) + 1);
        if (allowed && hits.length > 0)
            sections.set(heading, [...(sections.get(heading) ?? []), ...part.lines]);
    }
    return { sections, restored, skipped };
}
/** 放到同名分节最后一个非空行之后；没有同名分节或条目原本不在任何分节下时追加到文件末尾。 */
function insertIntoSection(lines, heading, blocks) {
    const section = heading === undefined ? undefined : findSection(lines, heading);
    if (section) {
        const at = sectionInsertAt(lines, section);
        return [...lines.slice(0, at), ...blocks, ...lines.slice(at)];
    }
    const end = sectionInsertAt(lines, { start: -1, end: lines.length });
    const body = heading === undefined ? blocks : ['', heading, ...blocks];
    return [...lines.slice(0, end), ...body, ...lines.slice(end)];
}
function extractQuotes(text) {
    return [...text.matchAll(QUOTE_RE)].map((match) => normalize(match[1])).filter(Boolean);
}
function normalize(text) {
    return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}
// ---------------------------------------------------------------------------
// 摘要「## 记忆请求」节（§5.18）
//
// 用户显式要求记住的内容由程序在保存 note 时直接写进已发布摘要，新开的会话读摘要即可看到。
// 这一节不属于「## 用户偏好」：既不受准入门核对，也不受手改保护；整理把对应 note 归置进
// 正式记忆后删除该行。
// ---------------------------------------------------------------------------
const REQUEST_HEADING = '## 记忆请求';
/**
 * 已发布摘要的最低合同（§5.6）：首行是精确的 `v2`。
 * 整理发布与程序直编共用这一个判断，避免两处口径漂移。
 */
export function isPublishedSummary(markdown) {
    return markdown.replace(/\r\n?/gu, '\n').split('\n')[0]?.trim() === 'v2';
}
/** 摘要注入预算的同一计数口径（§2.3 `maxSummaryInjectionTokens`）。 */
export function exceedsSummaryBudget(markdown, maxSummaryTokens) {
    return countO200kBaseTokens(markdown, { disallowedSpecial: new Set() }) > maxSummaryTokens;
}
/**
 * 单行请求正文的字符上限。摘要整体预算默认只有 2,500 token，一条请求最多占其中一小段；
 * 超长部分截断，模型按行尾的 note 路径用 `memories_read` 读全文。
 */
const MAX_REQUEST_BODY_CHARS = 200;
/**
 * 把一条记忆请求插进摘要的「## 记忆请求」节：正文压成一行、脱敏后截断、行尾附 note 路径。
 * 项目范围标注取自 note frontmatter 或 workspace 路径，不是用户口述内容，不参与脱敏。
 * 节不存在时紧跟首行 `v2` 新建，天然位于第一个二级标题之前；已存在时追加到节末尾。
 * 按 note 路径查重，同一次保存重放不会写出第二行。
 */
export function insertSummaryRequestLine(input) {
    if (!isPublishedSummary(input.summaryMarkdown))
        return { status: 'rejected', reason: 'summary-not-v2' };
    const lines = input.summaryMarkdown.replace(/\r\n?/gu, '\n').split('\n');
    if (lines.some((line) => line.includes(input.notePath)))
        return { status: 'already-present' };
    const line = renderSummaryRequestLine(input.note, input.notePath, input.projectLabel);
    const markdown = appendRequestLine(lines, line);
    if (exceedsSummaryBudget(markdown, input.maxSummaryTokens))
        return { status: 'rejected', reason: 'summary-budget-exceeded' };
    return { status: 'inserted', markdown, line };
}
/** 把一行请求放到「## 记忆请求」节末尾；节不存在时紧跟首行 `v2` 新建。 */
function appendRequestLine(lines, line) {
    const out = [...lines];
    const section = findSection(lines, REQUEST_HEADING);
    if (section) {
        out.splice(sectionInsertAt(out, section), 0, line);
    }
    else {
        out.splice(1, 0, '', REQUEST_HEADING, line, '');
    }
    return collapseBlankRuns(out).join('\n');
}
/** 请求行行尾的 note 路径。 */
const REQUEST_LINE_NOTE_RE = /（note: ([^）]+)）$/u;
/** 摘要「## 记忆请求」节中带 note 路径的请求行。 */
function listSummaryRequestLines(markdown) {
    const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
    const section = findSection(lines, REQUEST_HEADING);
    if (!section)
        return [];
    return lines
        .slice(section.start + 1, section.end)
        .filter((line) => REQUEST_LINE_NOTE_RE.test(line.trim()));
}
/**
 * 摘要从 before 变成 after 时，如果唯一的差异是「## 记忆请求」节新增的请求行（保存 note 时程序直接
 * 写入），返回这些新增行；没有差异返回空数组；有任何其他差异（例如用户手改）返回 undefined。
 * 整理续跑据此决定把请求行补进草稿，还是放弃草稿，免得覆盖别处的修改。
 */
export function addedSummaryRequestLines(before, after) {
    if (before === after)
        return [];
    const existing = new Set(listSummaryRequestLines(before));
    const added = listSummaryRequestLines(after).filter((line) => !existing.has(line));
    if (added.length === 0)
        return undefined;
    // 逐行比较其余内容：插入请求行只会多出这些行，以及原来没有这一节时的节标题与空行。
    const removed = new Set(added.map((line) => line.trimEnd()));
    const beforeLines = contentLines(before);
    const hadSection = beforeLines.some((line) => line.trim() === REQUEST_HEADING);
    const rest = contentLines(after).filter((line) => !removed.has(line) && (hadSection || line.trim() !== REQUEST_HEADING));
    return JSON.stringify(rest) === JSON.stringify(beforeLines) ? added : undefined;
}
/** 非空行，去掉行尾空白；空行不承载内容，不参与比较。 */
function contentLines(markdown) {
    return markdown
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line !== '');
}
/**
 * 把请求行原样补进摘要的「## 记忆请求」节。同一 note 已有请求行时跳过；补进后超出摘要预算的行
 * 不补（dropped），与保存 note 时超预算不写摘要一致，note 本身已保存，由下一轮整理归置。
 */
export function carrySummaryRequestLines(summaryMarkdown, requestLines, maxSummaryTokens) {
    let markdown = summaryMarkdown;
    let carried = 0;
    let dropped = 0;
    for (const line of requestLines) {
        const notePath = REQUEST_LINE_NOTE_RE.exec(line.trim())?.[1];
        const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
        if (!notePath || lines.some((existing) => existing.includes(`（note: ${notePath}）`)))
            continue;
        const next = appendRequestLine(lines, line);
        if (exceedsSummaryBudget(next, maxSummaryTokens)) {
            dropped += 1;
            continue;
        }
        markdown = next;
        carried += 1;
    }
    return { markdown, carried, dropped };
}
/** 单行请求：项目范围标注 + 正文一行化、脱敏后截断，行尾附 note 路径供模型读全文。 */
function renderSummaryRequestLine(note, notePath, projectLabel) {
    const oneLine = note.replace(/\s+/gu, ' ').trim();
    // 先脱敏再截断：反过来会把密钥切成不匹配规则的碎片，反而留下残缺密钥。
    const body = truncateRequestBody(redactMemorySecrets(oneLine).content);
    const scope = projectLabel ? `[项目: ${projectLabel}] ` : '';
    return `- ${scope}${body}（note: ${notePath}）`;
}
/**
 * 从摘要的「## 记忆请求」节删掉指向给定 note 的行；节里删空后连标题一起去掉。
 * 遗忘、排除与会话删除都走这里，请求行不会在 note 消失后继续留在摘要里(§5.18)。
 */
function removeSummaryRequestLines(markdown, notePaths) {
    if (notePaths.size === 0)
        return { markdown, removed: 0 };
    const lines = markdown.replace(/\r\n?/gu, '\n').split('\n');
    const section = findSection(lines, REQUEST_HEADING);
    if (!section)
        return { markdown, removed: 0 };
    let removed = 0;
    const kept = [];
    for (const line of lines.slice(section.start + 1, section.end)) {
        const matches = [...notePaths].some((path) => line.includes(`（note: ${path}）`));
        if (matches)
            removed += 1;
        else
            kept.push(line);
    }
    if (removed === 0)
        return { markdown, removed };
    const body = kept
        .filter((line, index) => line.trim() !== '' || index > 0)
        .join('\n')
        .trim();
    const head = body.length > 0 ? [REQUEST_HEADING, ...body.split('\n'), ''] : [];
    return {
        markdown: collapseBlankRuns([
            ...lines.slice(0, section.start),
            ...head,
            ...lines.slice(section.end),
        ]).join('\n'),
        removed,
    };
}
/** 删掉指向某个 note 的请求行，作为 editSummaryAndBaseline 的编辑回调。 */
export function dropRequestLineEdit(markdown, noteSessionId) {
    const edited = removeSummaryRequestLines(markdown, new Set([noteFilePath(noteSessionId)]));
    return edited.removed > 0
        ? { status: 'changed', markdown: edited.markdown }
        : { status: 'unchanged' };
}
/** 按码点截断；截断落在脱敏标记中间时整体丢弃该标记，不留半个 `[REDACTED`。 */
function truncateRequestBody(body) {
    const chars = Array.from(body);
    if (chars.length <= MAX_REQUEST_BODY_CHARS)
        return body;
    const cut = chars.slice(0, MAX_REQUEST_BODY_CHARS).join('');
    for (let length = REDACTION_MARK.length - 1; length > 0; length -= 1) {
        const prefix = REDACTION_MARK.slice(0, length);
        if (cut.endsWith(prefix))
            return `${cut.slice(0, -length)}…`;
    }
    return `${cut}…`;
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