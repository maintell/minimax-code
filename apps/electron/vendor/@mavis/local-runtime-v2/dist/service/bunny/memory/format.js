import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';
import { MEMORY_TYPES, } from './contracts.js';
import { memoryDiskName } from './disk-layout.js';
import { bunnyMemoryBlock, DAILY_MEMORY_ERROR, FORGOTTEN_MEMORY_ERROR, MAIN_MEMORY_ERROR, MEMORY_FILE_ERROR, MEMORY_INJECTION_TAIL, memoryFormatError, memoryInjectionGroup, memoryInjectionLine, } from '../../coordinator-text/index.js';
/** Upper bound of the main memory: the whole `memory.md`, and the injected block. */
export const MAX_MEMORY_TOKENS = 5000;
export const EMPTY_MEMORY = '# Bunny 记得的事\n';
export const EMPTY_FORGOTTEN = '# 用户删除的记忆\n';
const isMemoryFile = (name) => name === 'MEMORY.md' || name === 'forgotten.md' || /^daily\/\d{4}-\d{2}-\d{2}\.md$/u.test(name);
export const dateKey = (ms) => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export const sourcesIn = (text) => [
    ...new Set(text.match(/mvs_[\w-]+\/[\w-]+/gu) ?? []),
];
export const oneLine = (text) => text.replace(/[\r\n]+/gu, ' ').trim();
const TYPE_LIST = MEMORY_TYPES.map((value) => `## ${value}`).join('、');
/**
 * The one token count of Bunny's memory: the eviction after a write and the consolidator's check
 * count the whole `memory.md`, the injection counts its `<bunny-memory>` block.
 */
export function memoryTokens(text) {
    return countTokens(text, { disallowedSpecial: new Set() });
}
/** Whether a main memory file, or an injected block, is over the limit. */
export const overMemoryLimit = (text) => memoryTokens(text) > MAX_MEMORY_TOKENS;
/** Tokens of an entry alone: the smallest main memory that holds it. */
export const entryTokens = (entry) => memoryTokens(serializeMemory([entry]));
/** Oldest first: by update date, then by entry number. The order eviction takes entries in. */
function oldestFirst(entries) {
    const date = (a, b) => Number(a.updated > b.updated) - Number(a.updated < b.updated);
    return [...entries].sort((a, b) => date(a, b) || Number(a.id.slice(2)) - Number(b.id.slice(2)));
}
/**
 * The main memory within the limit: the oldest entries leave first until the whole file fits,
 * whatever their type or basis. Entries keep their file order.
 */
export function fitMemory(entries) {
    const evicted = [];
    const queue = oldestFirst(entries);
    let kept = [...entries];
    while (kept.length && overMemoryLimit(serializeMemory(kept))) {
        const oldest = queue.shift();
        evicted.push(oldest);
        kept = kept.filter((entry) => entry !== oldest);
    }
    return { kept, evicted };
}
/**
 * Parses the main memory. A format error says, in Chinese, which line or entry is wrong and
 * how to fix it: every entry needs a type heading, an ID, a basis, a status and a source.
 */
export function parseMemory(text) {
    if (!text.trim())
        return [];
    const entries = [];
    let type;
    let current;
    let currentLine = 0;
    const flush = () => {
        if (!current)
            return;
        const id = current.id;
        const meta = current.meta;
        if (!type)
            throw new Error(MAIN_MEMORY_ERROR.noType(currentLine, id, TYPE_LIST));
        if (!meta)
            throw new Error(MAIN_MEMORY_ERROR.noMeta(currentLine, id));
        const basis = meta.match(/^依据：(用户原话|用户确认|AI 推断)/u)?.[1];
        if (!basis)
            throw new Error(MAIN_MEMORY_ERROR.badBasis(currentLine, id));
        const status = meta.match(/状态：(有效|待整理|待确认)/u)?.[1];
        if (!status)
            throw new Error(MAIN_MEMORY_ERROR.noStatus(currentLine, id));
        const sources = sourcesIn(meta);
        if (!sources.length)
            throw new Error(MAIN_MEMORY_ERROR.noSource(currentLine, id));
        if (entries.some((entry) => entry.id === id))
            throw new Error(MAIN_MEMORY_ERROR.duplicateId(currentLine, id));
        entries.push({
            ...current,
            type,
            basis,
            status,
            sources,
            first: meta.match(/首次 ([\d-]+)/u)?.[1] ?? '',
            updated: meta.match(/更新 ([\d-]+)/u)?.[1] ?? '',
        });
        current = undefined;
    };
    const continuation = (line, number) => {
        if (line.startsWith('- '))
            throw new Error(MAIN_MEMORY_ERROR.noId(number, line));
        if (!current)
            throw new Error(MAIN_MEMORY_ERROR.orphan(number, line));
        if (line.startsWith('例：')) {
            if (current.example !== undefined)
                throw new Error(MAIN_MEMORY_ERROR.secondExample(number, line, current.id));
            current.example = line.slice(2);
        }
        else if (line.startsWith('依据：')) {
            if (current.meta !== undefined)
                throw new Error(MAIN_MEMORY_ERROR.secondMeta(number, line, current.id));
            current.meta = line;
        }
        else {
            throw new Error(MAIN_MEMORY_ERROR.badLine(number, line));
        }
    };
    for (const [index, raw] of text.split(/\r?\n/u).entries()) {
        const line = raw.trim();
        const number = index + 1;
        if (!line || line === EMPTY_MEMORY.trim())
            continue;
        if (line.startsWith('## ')) {
            flush();
            type = MEMORY_TYPES.find((value) => line === `## ${value}`);
            if (!type)
                throw new Error(MAIN_MEMORY_ERROR.badType(number, line, TYPE_LIST));
        }
        else if (/^- \[m-\d+\] .+/u.test(line)) {
            flush();
            const match = line.match(/^- \[(m-\d+)\] (.+)$/u);
            current = { id: match[1], content: match[2] };
            currentLine = number;
        }
        else
            continuation(line, number);
    }
    flush();
    return entries;
}
export function serializeMemory(entries) {
    return (EMPTY_MEMORY +
        MEMORY_TYPES.map((type) => {
            const group = entries.filter((entry) => entry.type === type);
            if (!group.length)
                return '';
            const records = group
                .map((entry) => [
                `- [${entry.id}] ${oneLine(entry.content)}\n`,
                entry.example ? `  例：${oneLine(entry.example)}\n` : '',
                `  依据：${entry.basis} · 出处：${entry.sources.join('；')} · 支持 ${entry.sources.length} 次 · 状态：${entry.status} · 首次 ${entry.first} · 更新 ${entry.updated}\n`,
            ].join(''))
                .join('');
            return `\n## ${type}\n${records}`;
        }).join(''));
}
const EMPTY_ARCHIVE = '# 超出上限移出的记忆\n';
/**
 * The archive with these evicted entries appended as they were in the main memory (ID, text,
 * example, basis, sources, dates), each followed by its type and the local time it left.
 */
export function appendArchive(archive, entries, atMs) {
    const at = new Date(atMs);
    const time = `${dateKey(atMs)} ${[at.getHours(), at.getMinutes(), at.getSeconds()]
        .map((value) => String(value).padStart(2, '0'))
        .join(':')}`;
    const records = entries.map((entry) => {
        const lines = serializeMemory([entry]).split('\n');
        // The entry's own lines, without the file title and its type heading.
        const own = lines.slice(lines.findIndex((line) => line.startsWith('- [')));
        return `${own.join('\n').trimEnd()}\n  分类：${entry.type} · 移出于 ${time}\n`;
    });
    return `${(archive || EMPTY_ARCHIVE).trimEnd()}\n\n${records.join('')}`;
}
/** Entry numbers the archive holds, for the ID high-water mark. */
export function archivedEntryNumbers(archive) {
    return [...archive.matchAll(/^- \[m-(\d+)\] /gmu)].map((match) => Number(match[1]));
}
/**
 * A memory file whose content cannot be parsed; the user can repair it from settings.
 * The message names the file as it is on disk, below Bunny's home (`memory/memory.md`),
 * and says in Chinese what is wrong and how to fix it.
 */
export class BunnyMemoryFormatError extends Error {
    file;
    constructor(file, cause) {
        super(memoryFormatError(memoryDiskName(file), cause instanceof Error ? cause.message : String(cause)), { cause });
        this.file = file;
        this.name = 'BunnyMemoryFormatError';
    }
}
export function validateFiles(files) {
    for (const [name, text] of Object.entries(files)) {
        try {
            if (!isMemoryFile(name))
                throw new Error(MEMORY_FILE_ERROR.notMemory);
            if (Buffer.byteLength(text) > 2 * 1024 * 1024)
                throw new Error(MEMORY_FILE_ERROR.tooLarge);
            if (name === 'MEMORY.md')
                parseMemory(text);
            if (name === 'forgotten.md')
                parseForgotten(text);
            if (name.startsWith('daily/'))
                validateDaily(name, text);
        }
        catch (error) {
            throw new BunnyMemoryFormatError(name, error);
        }
    }
}
/**
 * Parses the deleted memories. Each is written like a main-memory entry: `- [m-02] 内容`,
 * then `  出处：<会话>/<消息> · 删除于 <日期>`. A format error says, in Chinese, which line
 * is wrong and how to fix it.
 */
export function parseForgotten(text) {
    const rules = [];
    let current;
    const flush = () => {
        if (!current)
            return;
        if (current.source === undefined)
            throw new Error(FORGOTTEN_MEMORY_ERROR.noSource(current.line, current.id));
        const sources = sourcesIn(current.source);
        if (!sources.length)
            throw new Error(FORGOTTEN_MEMORY_ERROR.badSource(current.line, current.id));
        rules.push({
            id: current.id,
            content: current.content,
            sources,
            deletedOn: current.source.match(/删除于 (\d{4}-\d{2}-\d{2})/u)?.[1] ?? '',
        });
        current = undefined;
    };
    for (const [index, raw] of text.split(/\r?\n/u).entries()) {
        const line = raw.trim();
        if (!line || line === EMPTY_FORGOTTEN.trim())
            continue;
        const number = index + 1;
        const entry = line.match(/^- \[(m-\d+)\] (.+)$/u);
        if (entry) {
            flush();
            current = { id: entry[1], content: entry[2], line: number };
        }
        else if (line.startsWith('- '))
            throw new Error(FORGOTTEN_MEMORY_ERROR.badStart(number, line));
        else if (!current)
            throw new Error(FORGOTTEN_MEMORY_ERROR.orphan(number, line, EMPTY_FORGOTTEN.trim()));
        else if (!line.startsWith('出处：'))
            throw new Error(FORGOTTEN_MEMORY_ERROR.badLine(number, line));
        else if (current.source !== undefined)
            throw new Error(FORGOTTEN_MEMORY_ERROR.secondSource(number, line, current.id));
        else
            current.source = line;
    }
    flush();
    return rules;
}
export function serializeForgotten(rules) {
    if (!rules.length)
        return EMPTY_FORGOTTEN;
    const entries = rules.map((rule) => `- [${rule.id}] ${oneLine(rule.content)}\n  出处：${rule.sources.join('；')}${rule.deletedOn ? ` · 删除于 ${rule.deletedOn}` : ''}\n`);
    return `${EMPTY_FORGOTTEN}\n${entries.join('')}`;
}
const DAILY_HEADER = /^- \[(d-\d{4}-\d+)\] (画像|倾向|做法|去处) · (用户原话|用户确认|AI ?推断) · (待观察|(?:支持|反对|已晋升) m-\d+|不再成立)/u;
const DAILY_FIELDS = ['现象：', '触发：', '期待：', '出处：'];
/**
 * A daily record written with `AI推断` means `AI 推断`: header lines are written back with the
 * space, the one form the memory files use.
 */
export function normalizeDailyBasis(text) {
    return text.replace(/^(- \[d-\d{4}-\d+\] (?:画像|倾向|做法|去处) · )AI推断(?= · |$)/gmu, '$1AI 推断');
}
/** What is wrong with a record's first line: the part that is wrong, and what it may be. */
function dailyHeaderError(line, header) {
    const parts = /^- \[(d-\d{4}-\d+)\] (.*)$/u.exec(header);
    if (!parts)
        return DAILY_MEMORY_ERROR.badStart(line, header);
    const id = parts[1];
    const [type = '', basis = '', status = ''] = parts[2].split(' · ');
    if (!MEMORY_TYPES.includes(type))
        return DAILY_MEMORY_ERROR.badType(line, id, type);
    if (!/^(?:用户原话|用户确认|AI ?推断)$/u.test(basis))
        return DAILY_MEMORY_ERROR.badBasis(line, id, basis);
    if (!/^(?:待观察|(?:支持|反对|已晋升) m-\d+|不再成立)/u.test(status))
        return DAILY_MEMORY_ERROR.badStatus(line, id, status);
    return DAILY_MEMORY_ERROR.badStart(line, header);
}
function validateDaily(name, text) {
    const date = name.slice(6, -3);
    if (!text.startsWith(`# ${date}\n`))
        throw new Error(DAILY_MEMORY_ERROR.badTitle(date));
    const ids = new Set();
    let offset = 0;
    for (const [index, block] of text.split(/(?=^- \[d-)/mu).entries()) {
        const line = text.slice(0, offset).split('\n').length;
        offset += block.length;
        if (index === 0)
            continue;
        const record = block.split('\n## 整理记录')[0];
        const id = record.match(DAILY_HEADER)?.[1];
        if (!id)
            throw new Error(dailyHeaderError(line, record.split('\n')[0]));
        if (ids.has(id))
            throw new Error(DAILY_MEMORY_ERROR.duplicateId(line, id));
        const missing = DAILY_FIELDS.filter((field) => !record.includes(`  ${field}`));
        if (missing.length)
            throw new Error(DAILY_MEMORY_ERROR.missingFields(line, id, missing));
        if (!sourcesIn(record).length)
            throw new Error(DAILY_MEMORY_ERROR.noSource(line, id));
        ids.add(id);
    }
}
export function appendDaily(files, date, record) {
    const name = `daily/${date}.md`;
    const current = files[name] ?? `# ${date}\n\n## 记录\n`;
    const index = current.indexOf('\n## 整理记录');
    files[name] =
        index < 0
            ? `${current.trimEnd()}\n${record}\n`
            : `${current.slice(0, index).trimEnd()}\n${record}\n${current.slice(index)}`;
}
/**
 * The `<bunny-memory>` block. Only entries in effect are injected: an entry the recorder
 * added (待整理) or one with counter-evidence or unverified provenance (待确认) waits in
 * memory.md until the consolidator settles it, so a wrong note never reaches every Turn.
 * A block over the limit (memory.md changed outside the app) leaves out the oldest entries,
 * never the newest.
 */
export function memoryInjection(all) {
    let entries = all.filter((entry) => entry.status === '有效');
    const queue = oldestFirst(entries);
    let block = renderInjection(entries);
    while (block && overMemoryLimit(block)) {
        const oldest = queue.shift();
        entries = entries.filter((entry) => entry !== oldest);
        block = renderInjection(entries);
    }
    return block;
}
function renderInjection(entries) {
    if (!entries.length)
        return '';
    const groups = [];
    for (const type of ['做法', '画像', '倾向', '去处']) {
        const lines = entries
            .filter((value) => value.type === type)
            .map((entry) => memoryInjectionLine({
            content: entry.content,
            ...(entry.example ? { example: entry.example } : {}),
            basis: entry.basis,
            repeated: entry.sources.length > 1,
        }));
        if (lines.length)
            groups.push(memoryInjectionGroup(type, lines));
    }
    const content = groups.join('\n').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
    const updated = entries
        .map((entry) => entry.updated)
        .sort()
        .at(-1)
        ?.replace(/[^\d-]/gu, '') ?? '';
    return bunnyMemoryBlock(updated, [content, MEMORY_INJECTION_TAIL]);
}
//# sourceMappingURL=format.js.map