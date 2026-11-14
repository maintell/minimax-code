import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { messageSearchDocs, messageSearchFts } from '../../../../infra/db/schema/message-search.js';
import { defaultSearchTokenizer } from './tokenizer.js';
/**
 * Messages of one Session whose documents contain `term` as an exact phrase, newest
 * first and at most `limit` distinct messages, all written before `beforeMs` when it is
 * given. The word column is tried first; a term the segmenter split differently from
 * the document falls back to the character column.
 */
export function findTermMessages(db, input) {
    const tokenizer = input.tokenizer ?? defaultSearchTokenizer();
    const columns = tokenizer.segmentsWords
        ? [
            ['words', tokenizer.words(input.term)],
            ['chars', tokenizer.chars(input.term)],
        ]
        : [['chars', tokenizer.chars(input.term)]];
    for (const [column, tokens] of columns) {
        if (tokens.length === 0)
            continue;
        const phrase = `${column} : "${tokens.map((token) => token.text).join(' ')}"`;
        const found = distinctMessages(phraseRows(db, input.sessionId, phrase, input.beforeMs), input.limit);
        if (found.length > 0)
            return found;
    }
    return [];
}
function phraseRows(db, sessionId, phrase, beforeMs) {
    const docs = messageSearchDocs;
    return db
        .select({ messageId: docs.messageId, createdAtMs: docs.createdAtMs, body: docs.body })
        .from(messageSearchFts)
        .innerJoin(docs, eq(docs.id, messageSearchFts.rowid))
        .where(and(sql `${messageSearchFts} MATCH ${phrase}`, eq(docs.sessionId, sessionId), beforeMs === undefined ? undefined : lt(docs.createdAtMs, beforeMs)))
        .orderBy(desc(docs.createdAtMs), desc(docs.id))
        .all();
}
function distinctMessages(rows, limit) {
    const seen = new Set();
    const result = [];
    for (const row of rows) {
        if (seen.has(row.messageId))
            continue;
        seen.add(row.messageId);
        result.push(row);
        if (result.length >= limit)
            break;
    }
    return result;
}
/** Earliest write time of the given messages in the index; undefined when none is indexed. */
export function indexedMessageTime(db, sessionId, messageIds) {
    if (messageIds.length === 0)
        return undefined;
    const docs = messageSearchDocs;
    const row = db
        .select({ createdAtMs: sql `min(${docs.createdAtMs})` })
        .from(docs)
        .where(and(eq(docs.sessionId, sessionId), inArray(docs.messageId, [...messageIds])))
        .get();
    return row?.createdAtMs ?? undefined;
}
//# sourceMappingURL=terms.js.map