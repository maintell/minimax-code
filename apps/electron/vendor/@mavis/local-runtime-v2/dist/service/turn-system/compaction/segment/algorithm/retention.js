import { RETAINED_FINAL_REPLY, RETAINED_USER_MESSAGE, retainedFinalText, retainedOmission, retainedPreview, retainedUserWords, } from '../../../../coordinator-text/index.js';
import { coordinatorVisibleTexts, cardConclusions, userText, userWordsText } from './transcript.js';
/** Hidden host record type for text the rebuild rewrote (previews, reports, media). */
const SEGMENT_NOTE_TYPE = 'bunny_segment_note';
const PREVIEW_START_CHARS = 600;
const PREVIEW_MIN_CHARS = 24;
/**
 * Retention rules of a Bunny segment rebuild (12.4, 12.5, 12.6, 12.8, 9.1):
 * the most recent complete turns within their share (tool calls and results
 * stay together, delta blocks are removed, reports shrink to their
 * conclusion), at least the last turn, and older user words newest first
 * within their share. Kept user messages are referenced by source index so
 * their identity and bytes stay exactly as they were.
 */
export function planRetention(input) {
    const turns = groupTurns(input.records);
    const conclusions = cardConclusions(input.records);
    const recent = [];
    let recentTokens = 0;
    let lastTurnReduced = 'none';
    for (let position = turns.length - 1; position >= 0; position -= 1) {
        const items = turnItems(input, turns[position], conclusions);
        const cost = input.counter.countMessages(items.map((item) => item.message));
        if (recentTokens + cost <= input.recentTurnsTokens) {
            recent.unshift(items);
            recentTokens += cost;
            continue;
        }
        if (recent.length === 0) {
            const reduced = reduceLastTurn(input, turns[position]);
            recent.unshift(reduced.items);
            recentTokens += input.counter.countMessages(reduced.items.map((item) => item.message));
            lastTurnReduced = reduced.mode;
        }
        break;
    }
    const firstRecent = turns.length - recent.length;
    const recentIndexes = new Set(turns.slice(firstRecent).flatMap((turn) => turn.indexes));
    const older = planOlderUserWords(input, recentIndexes);
    return {
        items: [...older.items, ...recent.flat()],
        recentTurnCount: recent.length,
        olderUserWordCount: older.items.length,
        lastTurnReduced,
        recentTokens,
        userWordsTokens: older.tokens,
    };
}
function groupTurns(records) {
    const turns = [];
    records.forEach((record, index) => {
        if (index === 0 && record.message.role === 'compactionSummary')
            return;
        const current = turns.at(-1);
        if (current && current.turnId === record.turnId)
            current.indexes.push(index);
        else
            turns.push({ start: index, indexes: [index], turnId: record.turnId });
    });
    return turns;
}
function turnItems(input, turn, conclusions) {
    return turn.indexes.flatMap((index) => {
        const record = input.records[index];
        const { message } = record;
        if (input.facts.isDeltaBlock(message))
            return [];
        if (message.role === 'user' && input.facts.classifyUser(record) === 'report') {
            const reduced = input.facts.reduceReport(record, conclusions);
            if (reduced)
                return [
                    { kind: 'new', from: index, message: noteMessage(reduced, readTime(message, input)) },
                ];
        }
        if (input.dropThinking && message.role === 'assistant' && hasThinking(message)) {
            return [
                {
                    kind: 'new',
                    from: index,
                    message: { ...message, content: message.content.filter((b) => b.type !== 'thinking') },
                },
            ];
        }
        return [{ kind: 'source', index, message }];
    });
}
/**
 * The last turn alone exceeds the share: keep its user message and Bunny's
 * final visible text; when even those do not fit, keep head and tail previews
 * with the display message ID and a retrieval hint, under new host IDs.
 */
function reduceLastTurn(input, turn) {
    const userIndex = turn.indexes.find((index) => isUserWords(input, input.records[index])) ??
        turn.indexes.find((index) => input.records[index].message.role === 'user');
    const finalText = lastVisibleText(input, turn);
    const userRecord = userIndex === undefined ? undefined : input.records[userIndex];
    const timestamp = input.timestamp;
    const exact = [
        ...(userIndex !== undefined && userRecord
            ? [{ kind: 'source', index: userIndex, message: userRecord.message }]
            : []),
        ...(finalText
            ? [
                {
                    kind: 'new',
                    from: finalText.index,
                    message: noteMessage(retainedFinalText(finalText.text), timestamp),
                },
            ]
            : []),
    ];
    const exactCost = input.counter.countMessages(exact.map((item) => item.message));
    if (exactCost <= input.recentTurnsTokens)
        return { items: exact, mode: 'final_text' };
    const pieces = [
        ...(userRecord && userIndex !== undefined
            ? [
                {
                    label: RETAINED_USER_MESSAGE,
                    id: input.facts.displayMessageId(userRecord),
                    text: userWordsText(userRecord.message),
                    from: userIndex,
                },
            ]
            : []),
        ...(finalText
            ? [
                {
                    label: RETAINED_FINAL_REPLY,
                    id: finalText.displayMessageId,
                    text: finalText.text,
                    from: finalText.index,
                },
            ]
            : []),
    ];
    const each = Math.max(1, Math.floor(input.recentTurnsTokens / Math.max(1, pieces.length)));
    return {
        items: pieces.map((piece) => ({
            kind: 'new',
            from: piece.from,
            message: noteMessage(fitPreview(piece, each, input.counter), timestamp),
        })),
        mode: 'preview',
    };
}
function lastVisibleText(input, turn) {
    for (let position = turn.indexes.length - 1; position >= 0; position -= 1) {
        const index = turn.indexes[position];
        const record = input.records[index];
        const text = coordinatorVisibleTexts(record.message).at(-1);
        if (text)
            return { text, displayMessageId: input.facts.displayMessageId(record), index };
    }
    return undefined;
}
function fitPreview(piece, budget, counter) {
    let chars = PREVIEW_START_CHARS;
    for (;;) {
        const rendered = renderPreview(piece, chars);
        if (counter.countText(rendered) <= budget || chars <= PREVIEW_MIN_CHARS)
            return rendered;
        chars = Math.max(PREVIEW_MIN_CHARS, Math.floor(chars / 2));
    }
}
function renderPreview(piece, chars) {
    return retainedPreview(piece, previewBody(piece.text, chars));
}
/** The head and tail of a text with the length left out between them (12.5). */
export function previewBody(text, chars = PREVIEW_START_CHARS) {
    const trimmed = text.trim();
    return trimmed.length <= chars * 2
        ? trimmed
        : retainedOmission(trimmed.slice(0, chars), trimmed.length - chars * 2, trimmed.slice(-chars));
}
/**
 * A note this retention wrote for the coordinator's last visible words of a
 * reduced turn, verbatim or as a preview: it stands for the coordinator having
 * spoken there.
 */
export function isRetainedFinalReply(message) {
    if (message.role !== 'custom' || Reflect.get(message, 'customType') !== SEGMENT_NOTE_TYPE)
        return false;
    const text = userText(message);
    return text.startsWith(retainedFinalText('')) || text.startsWith(`${RETAINED_FINAL_REPLY}过长`);
}
function planOlderUserWords(input, recentIndexes) {
    const picked = [];
    let tokens = 0;
    for (let index = input.records.length - 1; index >= 0; index -= 1) {
        if (recentIndexes.has(index))
            continue;
        const record = input.records[index];
        if (!isUserWords(input, record))
            continue;
        const item = olderUserItem(input, record, index);
        const cost = input.counter.countMessages([item.message]);
        if (tokens + cost > input.userWordsTokens)
            break;
        picked.unshift(item);
        tokens += cost;
    }
    return { items: picked, tokens };
}
/**
 * An older user message is kept verbatim when its text is the user's words
 * alone. Inline media is replaced by asset ID and description (12.6), and host
 * text in front of the words (reminder blocks, the per-turn tool-calling note)
 * is left out so that the share holds the user's words instead (12.4); either
 * way the copy is a new host record carrying the display message ID, and the
 * original record leaves the segment.
 */
function olderUserItem(input, record, index) {
    const content = Reflect.get(record.message, 'content');
    const hasMedia = Array.isArray(content) &&
        content.some((block) => block && typeof block === 'object' && Reflect.get(block, 'type') !== 'text');
    const ownWordsOnly = userWordsText(record.message) === userText(record.message).trim();
    if (!hasMedia && ownWordsOnly)
        return { kind: 'source', index, message: record.message };
    const attachments = input.facts.assetsOf(record).map((asset) => {
        const description = input.mediaDescriptions.get(asset.assetId);
        return {
            assetId: asset.assetId,
            name: asset.name,
            ...(description === undefined ? {} : { description }),
        };
    });
    return {
        kind: 'new',
        from: index,
        message: noteMessage(retainedUserWords(input.facts.displayMessageId(record), userWordsText(record.message), attachments), readTime(record.message, input)),
    };
}
function isUserWords(input, record) {
    if (record.message.role !== 'user')
        return false;
    const kind = input.facts.classifyUser(record);
    return kind === 'typed' || kind === 'questionnaire';
}
function hasThinking(message) {
    return (message.role === 'assistant' &&
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === 'thinking'));
}
function readTime(message, input) {
    const value = Reflect.get(message, 'timestamp');
    return typeof value === 'number' && Number.isFinite(value) ? value : input.timestamp;
}
/** A hidden host note the model reads as context; it never shows in the main conversation. */
function noteMessage(text, timestamp) {
    return {
        role: 'custom',
        customType: SEGMENT_NOTE_TYPE,
        content: text,
        display: false,
        timestamp,
    };
}
//# sourceMappingURL=retention.js.map