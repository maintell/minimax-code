import { MEDIA_PLACEHOLDER_WEIGHT, mediaPlaceholderText, movedFilePath, movedToolMediaPlaceholder, movedToolResultText, savedToolMediaLine, } from '../../../../coordinator-text/index.js';
import { inlineAttachmentFlags } from '../algorithm/transcript.js';
/** Text blocks a level wrote in place of media, told apart from the message's own text. */
const placeholderBlocks = new WeakSet();
function placeholder(text) {
    const block = { type: 'text', text };
    placeholderBlocks.add(block);
    return block;
}
export function isPlaceholder(block) {
    return !!block && typeof block === 'object' && placeholderBlocks.has(block);
}
/** The message without the placeholders a level wrote into it. */
export function withoutPlaceholders(message) {
    const content = Reflect.get(message, 'content');
    if (!Array.isArray(content) || !content.some(isPlaceholder))
        return message;
    return { ...message, content: content.filter((block) => !isPlaceholder(block)) };
}
/**
 * Replaces the content a rebuild level removes (spec 4.4). The image and
 * tight levels turn every image and video into a text placeholder; the tight
 * and safety levels drop all thinking; the safety level moves the running
 * Turn's tool results into files and keeps only its tool calls. Each
 * placeholder says where the original is (asset ID, message ID or file path).
 * A rewritten entry leaves its source record and is written as a new one.
 */
export async function applyRebuildLevel(input) {
    const replaced = { counts: {}, affected: [] };
    const context = { ...input, replaced };
    const replaceMedia = input.level === 'image' || input.level === 'tight';
    const dropThinking = input.level === 'tight' || input.level === 'safety';
    const safety = input.level === 'safety';
    const entries = [];
    for (const entry of input.entries) {
        let next = entry;
        if (safety && entry.place === 'turn')
            next = await moveTurnContentOut(next, context);
        if (replaceMedia)
            next = await replaceMediaOf(next, context);
        if (dropThinking)
            next = withoutThinking(next, replaced);
        // An assistant message left with nothing to say goes; a tool call always stays.
        if (next.message.role === 'assistant' && next.message.content.length === 0)
            continue;
        entries.push(next);
    }
    return { entries, replaced };
}
/** The safety level keeps only the running Turn's tool calls; their results go into files. */
async function moveTurnContentOut(entry, context) {
    const { message } = entry;
    if (message.role === 'assistant') {
        const calls = message.content.filter((block) => block.type === 'toolCall');
        return calls.length === message.content.length
            ? entry
            : rewritten(entry, { ...message, content: calls });
    }
    if (message.role !== 'toolResult')
        return entry;
    const text = blockText(message.content);
    const saved = await requireFiles(context).saveText(context.sessionId, {
        key: message.toolCallId,
        kind: 'tool_result',
        text,
    });
    const media = await saveToolMedia(message, context);
    count(context.replaced, 'tool_result');
    return {
        ...rewritten(entry, {
            ...message,
            content: [
                {
                    type: 'text',
                    text: [
                        movedToolResultText(message.toolName, message.toolCallId, savedPath(saved)),
                        ...media,
                    ].join('\n'),
                },
            ],
        }),
        filed: true,
    };
}
/**
 * The counter the retention shares are measured with at a level: the image
 * and tight levels weigh each image and video as the placeholder it becomes,
 * so a turn is not left out for media the rebuild replaces anyway.
 */
export function levelCounter(level, counter) {
    if (level !== 'image' && level !== 'tight')
        return counter;
    return {
        countText: (text) => counter.countText(text),
        countMessages: (messages) => counter.countMessages(messages.map(mediaWeighedAsText)),
    };
}
function mediaWeighedAsText(message) {
    const content = Reflect.get(message, 'content');
    if (!Array.isArray(content) || !content.some(isMedia))
        return message;
    return {
        ...message,
        content: content.map((block) => isMedia(block) ? { type: 'text', text: MEDIA_PLACEHOLDER_WEIGHT } : block),
    };
}
/** Images and videos become text placeholders: user attachments by asset, tool output by file. */
async function replaceMediaOf(entry, context) {
    const { message } = entry;
    if (message.role === 'toolResult') {
        if (!message.content.some(isMedia))
            return entry;
        const content = [];
        for (const block of message.content) {
            if (!isMedia(block)) {
                content.push(block);
                continue;
            }
            const saved = await requireFiles(context).saveMedia(context.sessionId, {
                key: message.toolCallId,
                kind: `tool_${block.type}`,
                data: block.data,
                mimeType: block.mimeType,
            });
            count(context.replaced, block.type);
            content.push(placeholder(movedToolMediaPlaceholder(block.type, savedPath(saved))));
        }
        return rewritten(entry, { ...message, content });
    }
    if (message.role !== 'user' || !Array.isArray(message.content) || !entry.record)
        return entry;
    if (!message.content.some(isMedia))
        return entry;
    const record = entry.record;
    const messageId = context.facts.displayMessageId(record);
    const inline = inlineMedia(record, context.facts);
    const names = [];
    let position = 0;
    const content = message.content.map((block) => {
        if (!isMedia(block))
            return block;
        const asset = inline[position];
        position += 1;
        count(context.replaced, block.type);
        if (asset)
            names.push(asset.name);
        return placeholder(mediaPlaceholder(block.type, asset, messageId, context));
    });
    if (entry.place !== 'retained')
        context.replaced.affected.push({ messageId, names, media: true });
    return rewritten(entry, { ...message, content });
}
function mediaPlaceholder(type, asset, messageId, context) {
    if (!asset)
        return mediaPlaceholderText(type, messageId);
    const description = context.descriptions.get(asset.assetId);
    return mediaPlaceholderText(type, messageId, {
        assetId: asset.assetId,
        name: asset.name,
        ...(description === undefined ? {} : { description }),
    });
}
/** The attachments sent inline as media blocks, in block order. */
function inlineMedia(record, facts) {
    const flags = inlineAttachmentFlags(record.message);
    return facts
        .assetsOf(record)
        .filter((asset, index) => flags[index] === true && (asset.kind === 'image' || asset.kind === 'video'));
}
function withoutThinking(entry, replaced) {
    const { message } = entry;
    if (message.role !== 'assistant')
        return entry;
    const kept = message.content.filter((block) => block.type !== 'thinking');
    if (kept.length === message.content.length)
        return entry;
    count(replaced, 'thinking', message.content.length - kept.length);
    return rewritten(entry, { ...message, content: kept });
}
/** A tool result's images and videos into files; one line naming each file. */
export async function saveToolMedia(message, context) {
    const lines = [];
    for (const block of message.content) {
        if (!isMedia(block))
            continue;
        const saved = await requireFiles(context).saveMedia(context.sessionId, {
            key: message.toolCallId,
            kind: `tool_${block.type}`,
            data: block.data,
            mimeType: block.mimeType,
        });
        lines.push(savedToolMediaLine(block.type, saved.path));
    }
    return lines;
}
export function requireFiles(context) {
    if (!context.files)
        throw new Error('emergency_files_unavailable');
    return context.files;
}
/** The path a placeholder names, with the line-cut copy when the read tool needs it. */
export function savedPath(saved) {
    return movedFilePath(saved.path, saved.readablePath);
}
export function rewritten(entry, message) {
    return { ...entry, message, source: null };
}
export function count(replaced, kind, by = 1) {
    replaced.counts[kind] = (replaced.counts[kind] ?? 0) + by;
}
/** A user message whose own words the soft line shortened is affected content too (5.1). */
export function shortened(replaced, messageId, how) {
    const at = replaced.affected.findIndex((item) => item.messageId === messageId);
    const item = replaced.affected[at];
    if (item)
        replaced.affected[at] = { ...item, shortened: how };
    else
        replaced.affected.push({ messageId, names: [], media: false, shortened: how });
}
/** Text blocks of a message, joined; media blocks are left out. */
export function blockText(content) {
    if (typeof content === 'string')
        return content;
    return content
        .flatMap((block) => block && typeof block === 'object' && Reflect.get(block, 'type') === 'text'
        ? [String(Reflect.get(block, 'text') ?? '')]
        : [])
        .join('\n');
}
function isMedia(block) {
    if (!block || typeof block !== 'object')
        return false;
    const type = Reflect.get(block, 'type');
    return type === 'image' || type === 'video';
}
//# sourceMappingURL=content.js.map