/**
 * Reads a `<review-target>` off the task a dispatch asks to review.
 *
 * Nothing here is written by a model: every field comes from the checked task's own stored
 * state, so the reviewer reads what the task really recorded instead of a hand-copied version.
 *
 * `user_selection_refs` is read back out of the dispatching turn's stored user input. The
 * structured anchors behind a chat-stream reference live only in the UI's localStorage
 * (`packages/ui/src/store/chat-stream-selection-context.ts`), and the UI→runtime send path
 * carries one plain string (`packages/ui/src/components/layout/ChatPanel/composer/
 * useChatSendFlow.ts` sends `transportContent` as `content`; the runtime commits it verbatim as
 * the user row's `msg_content`). The reference block that string carries does spell out the
 * referenced message ID, so the refs are parsed from the stored text rather than from a new
 * column: that needs no change to the send contract, the commit contract, the message row or
 * any of its producers, and it reads references a message was already sent with.
 */
import { finalReply, lastReply } from './orchestration/report.service.js';
/** How far back a reviewed task's reply is looked for when its last round is unknown. */
const REPLY_LOOKBACK_MESSAGES = 50;
/** How far back this turn's user input is looked for when the dispatch names no Turn. */
const INPUT_LOOKBACK_MESSAGES = 20;
/**
 * The review target as the checked task recorded it. Every read is best-effort: a field that
 * cannot be read is left out of the block, because a review that says less is still a review,
 * while one that fails to dispatch is not.
 */
export async function readReviewTarget(sources, input) {
    const { sessionId, reportKey } = input.reviewOf;
    const assignment = await read(() => sources.tasks.get(sessionId));
    const materials = reportKey
        ? await readNamedReport(sources, sessionId, reportKey)
        : await readLatestRound(sources, sessionId);
    const refs = await readSelectionRefs(sources, input);
    return {
        sessionId,
        ...(reportKey ? { reportKey } : {}),
        ...(assignment?.goal ? { goal: assignment.goal } : {}),
        ...(assignment?.doneWhen?.length ? { doneWhen: assignment.doneWhen } : {}),
        ...(materials.reply.length ? { finalReply: materials.reply } : {}),
        ...(materials.files?.length
            ? { files: [...new Set(materials.files.map((file) => file.path))] }
            : {}),
        ...(materials.turnId ? { roundTurnId: materials.turnId } : {}),
        ...(materials.unavailable ? { materialsUnavailable: true } : {}),
        ...(refs.length ? { userSelectionRefs: refs } : {}),
    };
}
/**
 * The round a report key names, read from that round and from nowhere else.
 *
 * Every producer of a report key writes it as `<sessionId>:<turnId>:<state>`
 * (`report.service.ts` for a delivered report, `assignment.service.ts` for a conclusion),
 * so the round under review is read off the key itself and both the reply and the delivered
 * files are read with that same Turn. A key of any other shape — the failed-report variant
 * carries the error text in place of the round state — names no round this can find, and
 * neither does a key whose round recorded nothing: both degrade explicitly instead.
 */
async function readNamedReport(sources, sessionId, reportKey) {
    const turnId = reportKeyTurn(sessionId, reportKey);
    const messages = turnId ? await read(() => sources.facts.messages(sessionId, turnId)) : undefined;
    if (!turnId || !messages?.length)
        return { reply: [], files: undefined, unavailable: true };
    return {
        reply: boundReply(messages, sessionId),
        files: await read(() => sources.assets(sessionId, turnId)),
    };
}
/**
 * The checked task's latest round; used only when the dispatch names no report.
 *
 * The reply and the delivered files are read with that same Turn. Reading the files across the
 * whole Session would put an earlier round's deliveries next to the latest round's reply — a
 * task that delivered a draft in one round and the final version in the next would hand the
 * reviewer both, and the reviewer could check a version the task has already replaced. Only
 * the round-is-unknown fallback reads the Session as a whole, because then there is no Turn to
 * read by; that matches how the reply falls back to recent messages.
 */
async function readLatestRound(sources, sessionId) {
    const last = await read(() => sources.facts.lastTurn(sessionId));
    const messages = last
        ? await read(() => sources.facts.messages(sessionId, last.turnId))
        : await read(() => sources.messages.listRecent(sessionId, { limit: REPLY_LOOKBACK_MESSAGES }));
    return {
        reply: boundReply(messages ?? [], sessionId),
        files: last
            ? await read(() => sources.assets(sessionId, last.turnId))
            : await read(() => sources.assets(sessionId)),
        ...(last ? { turnId: last.turnId } : {}),
    };
}
/** The Turn a report key names, or undefined when it names none this reader can locate. */
function reportKeyTurn(sessionId, reportKey) {
    const parts = reportKey.split(':');
    if (parts.length !== 3 || parts[0] !== sessionId)
        return undefined;
    const turnId = parts[1];
    const state = parts[2];
    return turnId && state ? turnId : undefined;
}
/** One round's reply, bounded exactly as the task report bounds it. */
function boundReply(messages, sessionId) {
    const text = lastReply(messages);
    return text.trim() ? finalReply(text, sessionId) : [];
}
/** The references in the dispatching turn's own input, newest input first. */
async function readSelectionRefs(sources, input) {
    const { callerSessionId, callerTurnId } = input;
    const messages = callerTurnId
        ? await read(() => sources.facts.messages(callerSessionId, callerTurnId))
        : await read(() => sources.messages.listRecent(input.callerSessionId, {
            limit: INPUT_LOOKBACK_MESSAGES,
            role: 'user',
        }));
    const texts = (messages ?? [])
        .filter((message) => messageRole(message) === 'user')
        .map(messageText)
        .filter((text) => typeof text === 'string' && text.length > 0);
    return parseSelectionRefs(texts.join('\n'));
}
/** A read that cannot fail the dispatch; a failing read contributes nothing. */
async function read(run) {
    try {
        return await run();
    }
    catch {
        return undefined;
    }
}
function messageRole(message) {
    return typeof message === 'object' && message !== null ? Reflect.get(message, 'role') : undefined;
}
function messageText(message) {
    if (typeof message !== 'object' || message === null)
        return undefined;
    const body = Reflect.get(message, 'msg_content') ??
        Reflect.get(message, 'msgContent') ??
        Reflect.get(message, 'content');
    return typeof body === 'string' ? body : undefined;
}
// The reference block's shape is owned by the UI formatters; these read it back the same way
// `packages/ui/src/store/chat-context-display.ts` does.
const SURFACE_LINE = /^Surface:\s*([\w-]+)\s*$/u;
const WHOLE_MESSAGE_LINE = /^Quoted message\s*\(message ([^,]+?), part ([^,]*?)(?:, segment \d+ of \d+ in that reply)?(?:, task card)?, full text\):\s*"/u;
const EXCERPT_LINE = /^Quoted excerpt(?:\s+\d+)?\s*\(message ([^,]+?), part (\d+)\)(\s+\[activity card\])?:\s*"/u;
/**
 * Every reference the text carries, in order, each once per message and part.
 *
 * A quoted text may span lines — the formatter escapes quotes and backslashes but not
 * newlines — so the quote is read to its unescaped closing quote rather than to end of line.
 */
export function parseSelectionRefs(text) {
    const scan = { lines: text.split('\n'), refs: [], seen: new Set() };
    let surface;
    for (let index = 0; index < scan.lines.length; index += 1) {
        const line = scan.lines[index] ?? '';
        const surfaceMatch = SURFACE_LINE.exec(line);
        if (surfaceMatch) {
            surface = surfaceMatch[1];
            continue;
        }
        const match = matchQuoteLine(line);
        if (!match)
            continue;
        // A quoted text may carry lines of its own, including one shaped like `Surface: ...`.
        // Those belong to the quote, so the scan resumes after the quote rather than reading them
        // as metadata for whatever reference comes next.
        index = appendSelectionRef(scan, index, match, surface);
    }
    return scan.refs;
}
/** A whole-message quote wins over an excerpt on the same line; neither is not a quote. */
function matchQuoteLine(line) {
    return WHOLE_MESSAGE_LINE.exec(line) ?? EXCERPT_LINE.exec(line);
}
/**
 * Records the reference `match` names, unless it names none or repeats one already read.
 * Returns the last line the quote occupied, so the caller resumes after the quoted text
 * instead of reading lines that belong to it.
 */
function appendSelectionRef(scan, index, match, surface) {
    // Read the quote first: it decides where the scan resumes, even for a reference this
    // scan records nothing for.
    const quoted = readQuoted(scan.lines, index, match[0].length);
    const messageId = match[1]?.trim();
    if (!messageId)
        return quoted.lastLine;
    const part = match[2]?.trim() ?? '';
    const key = `${messageId}\u0000${part}`;
    if (scan.seen.has(key))
        return quoted.lastLine;
    scan.seen.add(key);
    scan.refs.push({
        messageId,
        ...(surface ? { surface } : {}),
        ...(quoted.text ? { summary: firstSentence(quoted.text) } : {}),
    });
    return quoted.lastLine;
}
/**
 * The quoted text that starts at `start` on `lines[index]`, up to its unescaped closing quote.
 * The formatter escapes `\` and `"` (`quoteText`), so an escaped quote does not end it.
 */
function readQuoted(lines, index, start) {
    let text = (lines[index] ?? '').slice(start);
    let cursor = index;
    for (;;) {
        const end = closingQuote(text);
        if (end >= 0)
            return { text: unquote(text.slice(0, end)), lastLine: cursor };
        cursor += 1;
        const next = lines[cursor];
        // An unterminated quote is a truncated or edited block; keep what it does carry.
        if (next === undefined)
            return { text: unquote(text), lastLine: cursor - 1 };
        text += `\n${next}`;
    }
}
/** The index of the first `"` in `text` that no backslash escapes, or -1. */
function closingQuote(text) {
    for (let index = 0; index < text.length; index += 1) {
        const char = text.charAt(index);
        if (char === '\\') {
            index += 1;
            continue;
        }
        if (char === '"')
            return index;
    }
    return -1;
}
/** Undoes the formatter's `quoteText` escaping. */
function unquote(value) {
    return value.replace(/\\"/gu, '"').replace(/\\\\/gu, '\\').trim();
}
/** The first sentence, so a reference line stays one line however long the quote is. */
function firstSentence(text) {
    const flat = text.replace(/\s+/gu, ' ').trim();
    return flat.match(/^[^。！？.!?]+[。！？.!?]?/u)?.[0]?.trim() ?? flat;
}
//# sourceMappingURL=review-target-reader.js.map