import { toolResultPreviewText, userMessagePreviewText, } from '../../../../coordinator-text/index.js';
import { previewBody } from '../algorithm/retention.js';
import { userWordsText } from '../algorithm/transcript.js';
import { blockText, count, isPlaceholder, requireFiles, rewritten, savedPath, saveToolMedia, shortened, withoutPlaceholders, } from './content.js';
/**
 * Fits the rebuilt request under the soft line S (spec 4.3, 4.5): the newest
 * user input alone over S goes into a file first; then the user's unreplied
 * messages turn into head-and-tail previews, the oldest first and the newest
 * last; then the running Turn's tool results go into files, the oldest first.
 * Still over S, the rebuild cannot be made. `measure` weighs the whole request,
 * its header included, for the entries and what has been replaced so far.
 */
export async function fitSoftLine(input) {
    const entries = [...input.entries];
    const fits = () => input.measure(entries, input.replaced) <= input.softLine;
    if ((await previewUserWords(entries, input, fits)) ||
        (await fileTurnResults(entries, input, fits)))
        return entries;
    throw new Error('over_soft_line');
}
/** The user's unreplied words: the newest into a file when alone over S, then previews. */
async function previewUserWords(entries, input, fits) {
    const userWords = entries.flatMap((entry, position) => entry.place !== 'retained' && entry.record && isUserWords(entry, input.facts) ? [position] : []);
    const newest = userWords.at(-1);
    const filed = newest !== undefined && overLine(entries[newest], input) ? newest : undefined;
    if (filed !== undefined)
        entries[filed] = await fileUserInput(entries[filed], input);
    for (const position of userWords) {
        if (fits())
            return true;
        if (position === filed)
            continue;
        const entry = entries[position];
        entries[position] = previewUserInput(entry, input, undefined);
        count(input.replaced, 'user_message');
        shortened(input.replaced, input.facts.displayMessageId(entry.record), 'preview');
    }
    return fits();
}
/** The running Turn's tool results into files, the oldest first. */
async function fileTurnResults(entries, input, fits) {
    for (let position = 0; position < entries.length; position += 1) {
        if (fits())
            return true;
        const entry = entries[position];
        if (entry.place !== 'turn' || entry.message.role !== 'toolResult' || entry.filed)
            continue;
        entries[position] = await fileToolResult(entry, input);
    }
    return fits();
}
function isUserWords(entry, facts) {
    if (entry.message.role !== 'user' || !entry.record)
        return false;
    const kind = facts.classifyUser(entry.record);
    return kind === 'typed' || kind === 'questionnaire';
}
/** The newest input's own words alone exceed S (4.5 item 1). */
function overLine(entry, input) {
    return input.counter.countText(ownWords(entry)) > input.softLine;
}
async function fileUserInput(entry, input) {
    const id = input.facts.displayMessageId(entry.record);
    const saved = await requireFiles(input).saveText(input.sessionId, {
        key: id,
        kind: 'user_message',
        text: ownWords(entry),
    });
    count(input.replaced, 'user_message');
    shortened(input.replaced, id, 'file');
    return previewUserInput(entry, input, savedPath(saved));
}
/** The user's own words of an entry, without the placeholders its level wrote. */
function ownWords(entry) {
    return userWordsText(withoutPlaceholders(entry.message));
}
/**
 * A user message as its head and tail (12.5), under a new host ID: the
 * message ID to read the whole of it, its attachments named by asset ID, and
 * the media blocks or placeholders the level left, as they were.
 */
function previewUserInput(entry, input, path) {
    const record = entry.record;
    const id = input.facts.displayMessageId(record);
    const assets = input.facts.assetsOf(record);
    const text = userMessagePreviewText({
        messageId: id,
        body: previewBody(ownWords(entry)),
        ...(path === undefined ? {} : { path }),
        assets,
    });
    const content = Reflect.get(entry.message, 'content');
    const media = Array.isArray(content)
        ? content.filter((block) => block &&
            typeof block === 'object' &&
            (Reflect.get(block, 'type') !== 'text' || isPlaceholder(block)))
        : [];
    const timestamp = Reflect.get(entry.message, 'timestamp');
    return rewritten(entry, {
        role: 'user',
        content: [{ type: 'text', text }, ...media],
        timestamp: typeof timestamp === 'number' ? timestamp : input.timestamp,
    });
}
/**
 * A tool result of the running Turn into a file, its head and tail in place
 * (4.5 item 2). The file holds all its text, the level's placeholders
 * included; its images and videos go into files of their own; the
 * placeholders stay in place after the preview.
 */
async function fileToolResult(entry, input) {
    const message = entry.message;
    const saved = await requireFiles(input).saveText(input.sessionId, {
        key: message.toolCallId,
        kind: 'tool_result',
        text: blockText(message.content),
    });
    const media = await saveToolMedia(message, input);
    count(input.replaced, 'tool_result');
    const own = blockText(message.content.filter((block) => !isPlaceholder(block)));
    const preview = toolResultPreviewText({
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        body: previewBody(own),
        path: savedPath(saved),
        mediaLines: media,
    });
    return {
        ...rewritten(entry, {
            ...message,
            content: [{ type: 'text', text: preview }, ...message.content.filter(isPlaceholder)],
        }),
        filed: true,
    };
}
//# sourceMappingURL=fit.js.map