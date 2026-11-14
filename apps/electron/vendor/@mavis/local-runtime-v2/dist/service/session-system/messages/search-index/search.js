import { createHash } from 'node:crypto';
import { estimateCharsToTokensCjkAware } from '@mavis/context-manager';
import { and, eq, gte, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import { messageSearchDocs, messageSearchFts } from '../../../../infra/db/schema/message-search.js';
import { SEARCH_ERROR } from '../../../coordinator-text/index.js';
import { hasAndOperator, queryTokens, toMatchExpression, tokenMatcher, } from './query.js';
import { defaultSearchTokenizer } from './tokenizer.js';
const SEARCH_PAGE_SIZE = 8;
const SNIPPET_CHARS = 200;
const OUTPUT_TOKEN_BUDGET = 3000;
const HALF_LIFE_MS = 30 * 86_400_000;
const MAX_MONTHS = 24;
/**
 * Searches one Session per spec 15.5 and 15.6: all keywords first, any keyword when
 * that finds nothing (`relaxed`), then the single-character column. Hits that matched
 * every keyword rank by bm25 with a 30-day half-life; relaxed and single-character hits
 * rank by bm25 alone. A page holds 8 hits with a snippet around the first hit token.
 */
export function searchMessages(db, input) {
    const tokenizer = input.tokenizer ?? defaultSearchTokenizer();
    const fingerprint = searchFingerprint(input);
    const cursor = decodeCursor(input.cursor, fingerprint);
    const nowMs = cursor?.nowMs ?? input.nowMs;
    for (const stage of searchStages(input.query, tokenizer)) {
        const rows = rankedRows(db, input, stage, nowMs);
        if (rows.length === 0)
            continue;
        const offset = cursor?.offset ?? 0;
        const page = rows.slice(offset, offset + SEARCH_PAGE_SIZE);
        const next = offset + page.length;
        return fitBudget({
            total: rows.length,
            by_month: byMonth(rows),
            ...(stage.relaxed ? { relaxed: true } : {}),
            hits: hitsOf(db, page, stage, tokenizer),
            ...(next < rows.length
                ? { next_cursor: encodeCursor({ offset: next, nowMs, fingerprint }) }
                : {}),
        });
    }
    return { total: 0, by_month: {}, hits: [] };
}
/**
 * bm25 relevance (higher is better) times a 30-day half-life decay on message age.
 * @internal Exported only for focused tests.
 */
export function rankScore(bm25, ageMs) {
    return -bm25 * 0.5 ** (Math.max(0, ageMs) / HALF_LIFE_MS);
}
function searchStages(query, tokenizer) {
    const stages = [];
    const columns = tokenizer.segmentsWords ? ['words', 'chars'] : ['chars'];
    for (const column of columns) {
        const parsed = queryTokens(column, query, tokenizer);
        if (parsed.keywords.length === 0)
            continue;
        stages.push({ column, query: parsed, relaxed: false });
        if (hasAndOperator(parsed))
            stages.push({ column, query: anyOf(parsed), relaxed: true });
    }
    return stages;
}
function anyOf(query) {
    return { ...query, operators: query.operators.map(() => 'OR') };
}
function rankedRows(db, input, stage, nowMs) {
    const rows = db
        .select({
        id: messageSearchDocs.id,
        createdAtMs: messageSearchDocs.createdAtMs,
        rank: sql `bm25(${messageSearchFts})`,
    })
        .from(messageSearchFts)
        .innerJoin(messageSearchDocs, eq(messageSearchDocs.id, messageSearchFts.rowid))
        .where(and(sql `${messageSearchFts} MATCH ${toMatchExpression(stage.column, stage.query)}`, eq(messageSearchDocs.sessionId, input.sessionId), ...filterConditions(input)))
        .all();
    return rows
        .map((row) => ({
        id: row.id,
        createdAtMs: row.createdAtMs,
        // Recency decides between hits that all matched; once the query had to be
        // relaxed, the hits differ in which words they matched, and decaying them
        // by age buries the early conversation instead (15.6).
        score: stage.relaxed ? -row.rank : rankScore(row.rank, nowMs - row.createdAtMs),
    }))
        .sort((left, right) => right.score - left.score || right.createdAtMs - left.createdAtMs || right.id - left.id);
}
/** Space and task come from the assignment or report the message is associated with. */
function filterConditions(input) {
    const docs = messageSearchDocs;
    const filters = input;
    return [
        nonEmpty(filters.excludeMessageIds, (ids) => notInArray(docs.messageId, ids)),
        filters.since === undefined ? undefined : gte(docs.createdAtMs, filters.since),
        filters.until === undefined ? undefined : lte(docs.createdAtMs, filters.until),
        filters.role ? eq(docs.role, filters.role) : undefined,
        filters.taskId ? eq(docs.taskId, filters.taskId) : undefined,
        filters.spaceId ? spaceCondition(filters.spaceId, input.spaces) : undefined,
    ];
}
function nonEmpty(values, condition) {
    return values === undefined || values.length === 0 ? undefined : condition([...values]);
}
function spaceCondition(spaceId, spaces) {
    const docs = messageSearchDocs;
    const linkedTasks = spaces?.spaceSessions(spaceId) ?? [];
    return or(eq(docs.spaceId, spaceId), nonEmpty(linkedTasks, (ids) => inArray(docs.taskId, ids)));
}
function hitsOf(db, page, stage, tokenizer) {
    if (page.length === 0)
        return [];
    const docs = messageSearchDocs;
    const rows = db
        .select({
        id: docs.id,
        messageId: docs.messageId,
        role: docs.role,
        createdAtMs: docs.createdAtMs,
        taskId: docs.taskId,
        assetId: docs.assetId,
        body: docs.body,
        wordOffsets: docs.wordOffsets,
        words: messageSearchFts.words,
    })
        .from(docs)
        .innerJoin(messageSearchFts, eq(messageSearchFts.rowid, docs.id))
        .where(inArray(docs.id, page.map(({ id }) => id)))
        .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const matches = tokenMatcher(stage.query);
    return page.flatMap(({ id }) => {
        const row = byId.get(id);
        if (!row)
            return [];
        const center = firstHitOffset(row, stage.column, matches, tokenizer);
        return [
            {
                message_id: row.messageId,
                time: formatMessageTime(row.createdAtMs),
                role: row.role,
                ...(row.taskId ? { task_id: row.taskId } : {}),
                ...(row.assetId ? { asset_id: row.assetId } : {}),
                snippet: snippetAround(row.body, center, SNIPPET_CHARS),
            },
        ];
    });
}
function firstHitOffset(row, column, matches, tokenizer) {
    if (column === 'chars') {
        return tokenizer.chars(row.body).find((token) => matches(token.text))?.start ?? 0;
    }
    const words = row.words.split(' ');
    const offsets = parseOffsets(row.wordOffsets);
    const index = words.findIndex((word) => matches(word));
    return index >= 0 ? (offsets[index * 2] ?? 0) : 0;
}
function parseOffsets(value) {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'number') : [];
    }
    catch {
        return [];
    }
}
/**
 * A window of at most `limit` characters from the original text, centered on the
 * UTF-16 offset of the first hit; whitespace runs collapse, cut ends get an ellipsis.
 */
export function snippetAround(body, center, limit) {
    const characters = Array.from(body);
    const centerIndex = Array.from(body.slice(0, center)).length;
    const room = limit - 2;
    const start = Math.max(0, Math.min(centerIndex - Math.floor(room / 2), characters.length - room));
    const end = Math.min(characters.length, start + room);
    const text = characters.slice(start, end).join('').replace(/\s+/gu, ' ').trim();
    return `${start > 0 ? '…' : ''}${text}${end < characters.length ? '…' : ''}`;
}
/** Local time, minute precision: what the user would say ("10 月 3 日下午那条"). */
export function formatMessageTime(ms) {
    const date = new Date(ms);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function byMonth(rows) {
    const counts = new Map();
    for (const row of rows) {
        const date = new Date(row.createdAtMs);
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const months = [...counts.entries()].sort(([left], [right]) => right.localeCompare(left));
    const shown = Object.fromEntries(months.slice(0, MAX_MONTHS));
    const earlier = months.slice(MAX_MONTHS).reduce((sum, [, count]) => sum + count, 0);
    return earlier > 0 ? { ...shown, earlier } : shown;
}
/** Keeps the whole result within the output budget by shortening snippets. */
function fitBudget(result) {
    let current = result;
    for (const limit of [160, 120, 80, 40]) {
        if (estimateCharsToTokensCjkAware(JSON.stringify(current)) <= OUTPUT_TOKEN_BUDGET)
            return current;
        current = {
            ...current,
            hits: current.hits.map((hit) => ({ ...hit, snippet: shorten(hit.snippet, limit) })),
        };
    }
    return current;
}
function shorten(snippet, limit) {
    const characters = Array.from(snippet);
    return characters.length <= limit ? snippet : `${characters.slice(0, limit - 1).join('')}…`;
}
function searchFingerprint(input) {
    return createHash('sha256')
        .update(JSON.stringify([
        input.sessionId,
        input.query,
        input.since,
        input.until,
        input.role,
        input.taskId,
        input.spaceId,
    ]))
        .digest('base64url')
        .slice(0, 16);
}
function encodeCursor(cursor) {
    return Buffer.from(JSON.stringify([cursor.offset, cursor.nowMs, cursor.fingerprint])).toString('base64url');
}
/** @internal Exported only for focused tests. */
export class SearchCursorError extends Error {
    name = 'SearchCursorError';
    constructor() {
        super(SEARCH_ERROR.cursor);
    }
}
function decodeCursor(value, fingerprint) {
    if (!value)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    }
    catch {
        throw new SearchCursorError();
    }
    if (!Array.isArray(parsed) || parsed[2] !== fingerprint)
        throw new SearchCursorError();
    const [offset, nowMs] = parsed;
    if (typeof offset !== 'number' || typeof nowMs !== 'number')
        throw new SearchCursorError();
    return { offset, nowMs, fingerprint };
}
//# sourceMappingURL=search.js.map