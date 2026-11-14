import { estimateCharsToTokensCjkAware } from '@mavis/context-manager';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { messageRows } from '../../../../infra/db/schema/messages.js';
import { searchMessageNotFound } from '../../../coordinator-text/index.js';
import { decodeDisplayMessage } from '../repo/codec.js';
import { extractSearchDocuments } from './documents.js';
import { NO_MEDIA_DESCRIPTIONS } from './options.js';
import { formatMessageTime } from './search.js';
/** @internal Exported only for focused tests. */
export const READ_TOKEN_BUDGET = 4000;
/** Room for field names and the neighbour lists around the target text. */
const READ_OVERHEAD_TOKENS = 300;
const MAX_AROUND = 3;
/** Rows scanned per side looking for readable neighbours (tool rows and cards have none). */
const NEIGHBOUR_SCAN = 200;
/** Characters the shared estimator counts as one token each; the rest cost a quarter. */
const CJK_TOKEN = /[\u{3000}-\u{303F}\u{3040}-\u{30FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}\u{AC00}-\u{D7AF}\u{20000}-\u{2FA1F}]/u;
/** @internal Exported only for focused tests. */
export class MessageNotFoundError extends Error {
    name = 'MessageNotFoundError';
    constructor(messageId) {
        super(searchMessageNotFound(messageId));
    }
}
/**
 * Reads a message and its readable neighbours from the original rows (spec 15.5). The
 * target comes first; a target over the budget is returned in chunks with `next_offset`.
 * Neighbours, up to `around` per side, are added near to far while they fit.
 */
export function readMessageContext(db, input) {
    const descriptions = input.descriptions ?? NO_MEDIA_DESCRIPTIONS;
    const row = db
        .select()
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, input.sessionId), eq(messageRows.messageId, input.messageId)))
        .get();
    const target = row && readable(db, row, descriptions);
    if (!row || !target)
        throw new MessageNotFoundError(input.messageId);
    const chunk = chunkTarget(target, input.offset ?? 0);
    if (chunk.next_offset !== undefined || (input.offset ?? 0) > 0)
        return { target: chunk, before: [], after: [] };
    const around = Math.max(0, Math.min(MAX_AROUND, Math.floor(input.around ?? MAX_AROUND)));
    const before = neighbours(db, row, { side: 'before', count: around, descriptions });
    const after = neighbours(db, row, { side: 'after', count: around, descriptions });
    return fitNeighbours(chunk, before, after);
}
function readable(db, row, descriptions) {
    let message;
    let drafts;
    try {
        message = decodeDisplayMessage(row);
        drafts = extractSearchDocuments(message);
    }
    catch {
        return undefined;
    }
    if (drafts.length === 0)
        return undefined;
    const cards = drafts.flatMap((draft) => draft.role === 'assistant' && draft.taskId && draft.part.startsWith('task:')
        ? [{ task_id: draft.taskId, conclusion: draft.body }]
        : []);
    const attachments = drafts.flatMap((draft) => draft.assetId ? [attachmentOf(db, row, draft, descriptions)] : []);
    const taskId = drafts.find((draft) => draft.taskId)?.taskId;
    return {
        message_id: row.messageId,
        time: formatMessageTime(row.createdAtMs),
        role: drafts[0]?.role ?? row.role ?? '',
        ...(taskId ? { task_id: taskId } : {}),
        text: storedText(message),
        ...(cards.length ? { card_conclusions: cards } : {}),
        ...(attachments.length ? { attachments } : {}),
    };
}
/** The text exactly as stored; the index's cleaned text is never shown in its place. */
function storedText(message) {
    const value = message.msg_content ?? message.msgContent;
    return typeof value === 'string' ? value : '';
}
function attachmentOf(db, row, draft, descriptions) {
    const assetId = draft.assetId ?? '';
    const description = descriptions
        .describe({ sessionId: row.sessionId, messageId: row.messageId, assetId })
        ?.trim();
    return {
        asset_id: assetId,
        file_name: draft.fileName ?? draft.body,
        ...(description ? { description } : {}),
    };
}
function neighbours(db, row, input) {
    const { side, count, descriptions } = input;
    if (count === 0)
        return [];
    const rows = db
        .select()
        .from(messageRows)
        .where(and(eq(messageRows.sessionId, row.sessionId), side === 'before' ? lt(messageRows.id, row.id) : gt(messageRows.id, row.id)))
        .orderBy(side === 'before' ? desc(messageRows.id) : asc(messageRows.id))
        .limit(NEIGHBOUR_SCAN)
        .all();
    const found = [];
    for (const candidate of rows) {
        const message = readable(db, candidate, descriptions);
        if (message)
            found.push(message);
        if (found.length >= count)
            break;
    }
    return found;
}
/** A chunk of the target text that fits the budget; offsets count UTF-16 code units. */
function chunkTarget(target, offset) {
    const start = Math.max(0, Math.min(Math.floor(offset), target.text.length));
    const budget = READ_TOKEN_BUDGET - READ_OVERHEAD_TOKENS - tokens(attachmentsOnly(target));
    const rest = target.text.slice(start);
    if (start === 0 && tokens(rest) <= budget)
        return target;
    let end = start + fittingLength(rest, budget);
    for (;;) {
        const chunk = {
            ...target,
            text: target.text.slice(start, end),
            offset: start,
            ...(end < target.text.length ? { next_offset: end } : {}),
        };
        // Escapes in the JSON output cost more than the estimate; shrink until it fits.
        if (tokens(chunk) <= READ_TOKEN_BUDGET || end - start <= 1)
            return chunk;
        end = start + Math.max(1, Math.floor((end - start) * 0.9));
        if (isLowSurrogate(target.text.charCodeAt(end)))
            end -= 1;
    }
}
/** UTF-16 length of the longest prefix of `text` whose estimated tokens fit `budget`. */
function fittingLength(text, budget) {
    let length = 0;
    let used = 0;
    for (const character of text) {
        used += CJK_TOKEN.test(character) ? 1 : 0.25;
        if (used > budget)
            break;
        length += character.length;
    }
    return length;
}
function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}
function fitNeighbours(target, before, after) {
    const kept = { before: [], after: [] };
    const open = { before: true, after: true };
    let used = tokens(target) + READ_OVERHEAD_TOKENS;
    for (let index = 0; index < MAX_AROUND; index++) {
        for (const side of ['before', 'after']) {
            const message = (side === 'before' ? before : after)[index];
            if (!message || !open[side])
                continue;
            const cost = tokens(message);
            if (used + cost > READ_TOKEN_BUDGET) {
                open[side] = false;
                continue;
            }
            used += cost;
            kept[side].push(message);
        }
    }
    const omitted = before.length + after.length - kept.before.length - kept.after.length;
    return {
        target,
        before: kept.before.reverse(),
        after: kept.after,
        ...(omitted > 0 ? { omitted } : {}),
    };
}
function attachmentsOnly(message) {
    return [message.attachments ?? [], message.card_conclusions ?? []];
}
function tokens(value) {
    return estimateCharsToTokensCjkAware(JSON.stringify(value));
}
//# sourceMappingURL=read.js.map