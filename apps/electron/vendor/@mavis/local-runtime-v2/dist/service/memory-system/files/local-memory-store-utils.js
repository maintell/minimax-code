import { readdir, readFile, unlink } from 'node:fs/promises';
import { LocalMemoryError } from './types.js';
export function appendWithSeparator(current, addition) {
    if (!current.trim())
        return addition;
    return `${current.replace(/\s*$/, '')}\n${addition}`;
}
export function applyEdit(current, oldString, newString, replaceAll) {
    if (!oldString)
        throw new LocalMemoryError('OLD_STRING_EMPTY', 'old_string is required');
    const matches = current.split(oldString).length - 1;
    if (matches === 0)
        throw new LocalMemoryError('OLD_STRING_NOT_FOUND', 'old_string not found');
    if (!replaceAll && matches > 1) {
        throw new LocalMemoryError('OLD_STRING_AMBIGUOUS', 'old_string is ambiguous');
    }
    // split/join inserts newString literally; String.prototype.replace would expand
    // $&, $$, $`, $' and silently rewrite the replacement text. The replaceAll=false
    // path is already guarded to a single match above.
    const content = current.split(oldString).join(newString);
    return { content, replacements: replaceAll ? matches : 1 };
}
/**
 * Whitespace separates search keywords. Agents routinely send several keywords in one
 * query, which almost never appear verbatim as one substring, so each keyword is matched
 * on its own.
 */
export function parseSearchTerms(query) {
    return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}
/** Number of distinct terms (already lowercased) that occur in `text`, case-insensitively. */
export function countMatchedTerms(text, terms) {
    const lower = text.toLowerCase();
    return terms.reduce((count, term) => (lower.includes(term) ? count + 1 : count), 0);
}
/**
 * Highest score first; equal scores keep input order. Re-ranks matches merged from several
 * memory sources, whose per-source order alone says nothing about the combined order.
 */
export function rankByScore(items, score) {
    return items
        .map((item) => ({ item, score: score(item) }))
        .sort((a, b) => b.score - a.score)
        .map(({ item }) => item);
}
/** Lines matching any keyword, most matched keywords first, file order within a tie. */
export function searchLines(content, query) {
    const terms = parseSearchTerms(query);
    if (terms.length === 0)
        return [];
    const lines = content.split(/\r?\n/);
    return lines
        .flatMap((line, index) => {
        const score = countMatchedTerms(line, terms);
        if (score === 0)
            return [];
        const context = lines.slice(Math.max(0, index - 1), index + 2);
        return [{ score, result: { lineNumber: index + 1, line, context } }];
    })
        .sort((a, b) => b.score - a.score)
        .map(({ result }) => result);
}
const TOPIC_HEADER_RE = /^---\ndescription: ([\s\S]*?)\n---\n\n/;
export function parseTopic(content) {
    const match = TOPIC_HEADER_RE.exec(content);
    if (!match)
        return { description: '', body: content };
    return { description: decodeURIComponent(match[1] ?? ''), body: content.slice(match[0].length) };
}
export function formatTopic(description, content) {
    return `---\ndescription: ${encodeURIComponent(description)}\n---\n\n${content}`;
}
export function formatLocalDate(input = Date.now()) {
    const date = input instanceof Date ? input : new Date(input);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function formatLocalDateTime(input) {
    const date = input instanceof Date ? input : new Date(input);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${formatLocalDate(date)} ${hours}:${minutes}:${seconds}`;
}
export function assertSafeAgentName(agentName) {
    const normalized = agentName?.trim();
    if (!normalized)
        throw new LocalMemoryError('AGENT_NAME_REQUIRED', 'agent_name is required');
    // Path-safety: the agent name becomes a path segment under agents/<name>/, so
    // reject anything that could escape that directory or break the path.
    if (normalized.includes('/') ||
        normalized.includes('\\') ||
        normalized.includes('..') ||
        Array.from(normalized).some((char) => char.charCodeAt(0) < 32)) {
        throw new LocalMemoryError('INVALID_AGENT_NAME', `invalid agent_name: ${agentName}`);
    }
    return normalized;
}
export function assertDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new LocalMemoryError('INVALID_DATE', 'invalid date');
    return date;
}
export function today() {
    return formatLocalDate();
}
export function formatTs(ts) {
    return formatLocalDateTime(ts);
}
export function byteLength(content) {
    return Buffer.byteLength(content, 'utf8');
}
export function firstLine(content) {
    return content
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0)
        ?.slice(0, 200);
}
export async function safeRead(filePath) {
    try {
        return await readFile(filePath, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return '';
        throw err;
    }
}
export async function safeReaddir(dir) {
    try {
        return await readdir(dir);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return [];
        throw err;
    }
}
export async function deleteIfExists(filePath) {
    try {
        await unlink(filePath);
        return true;
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return false;
        throw err;
    }
}
//# sourceMappingURL=local-memory-store-utils.js.map