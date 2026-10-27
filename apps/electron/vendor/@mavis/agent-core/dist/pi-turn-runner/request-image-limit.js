/**
 * Default ceiling on images in one provider request when the model declares
 * none (`capabilities.max_images_per_request`).
 *
 * Inline images live in persisted history and every request re-sends the whole
 * provider-visible history, so without a request-level ceiling a long session
 * eventually exceeds the provider's per-request image limit. Every following
 * request then fails the same way and the session cannot recover (#425: a
 * gateway rejected `Too many images in request: 31 > 30`).
 *
 * 20 stays below the smallest general-purpose limit seen in practice — the
 * gateway in #425 rejects more than 30 — with headroom for gateways that count
 * images differently, and far below the 100+ images per request that major
 * hosted APIs accept. It still keeps the attachments of the last five turns (at most four
 * inline images per user message) in view. Providers with a smaller limit set
 * `max_images_per_request` on the model; Mistral's API (8) is recognized by
 * host, see `knownMaxImagesPerRequestForBaseUrl`.
 */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 20;
/** Normalize a configured image ceiling; anything but a positive integer is ignored. */
export function normalizeMaxImagesPerRequest(value) {
    const parsed = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
            ? Number(value)
            : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
/**
 * Documented per-request image limits for first-party API hosts whose limit is
 * below the default. Matched on the exact hostname so gateways that merely
 * proxy these models keep the default unless they declare their own.
 */
const KNOWN_HOST_IMAGE_LIMITS = new Map([
    // Mistral Vision FAQ (docs.mistral.ai/capabilities/vision): "The maximum number
    // images per request via API is 8."
    ['api.mistral.ai', 8],
]);
/** Known image ceiling for a first-party API base URL, if it is below the default. */
export function knownMaxImagesPerRequestForBaseUrl(baseUrl) {
    if (!baseUrl)
        return undefined;
    try {
        return KNOWN_HOST_IMAGE_LIMITS.get(new URL(baseUrl).hostname.toLowerCase());
    }
    catch {
        return undefined;
    }
}
/** Image ceiling for requests to `model`: its declared limit, else the default. */
export function resolveMaxImagesPerRequest(model) {
    const declared = normalizeMaxImagesPerRequest(model?.maxImagesPerRequest);
    return declared ?? DEFAULT_MAX_IMAGES_PER_REQUEST;
}
// Model id marker of the Messages API model family, escaped like other vendor
// names in this repo.
const PREFIX_CACHED_MODEL_ID = /\x63\x6c\x61\x75\x64\x65/iu;
/**
 * Messages API models (direct, Bedrock or behind a gateway) cache the prompt by
 * its exact prefix, so dropping an earlier image from one request re-bills
 * every later message and degrades the cached context. Requests to them carry
 * every image in history; only context compaction removes images, once,
 * durably.
 */
export function keepsRequestImages(model) {
    return model !== undefined && PREFIX_CACHED_MODEL_ID.test(model.id);
}
/**
 * Keep only the newest `maxImages` image blocks across the whole request
 * (user messages and tool results) and replace older ones with a short text
 * placeholder naming the original file when it is known.
 *
 * Operates on the temporary provider request copy only; canonical history is
 * never rewritten, so raising the limit (or switching to a model with a higher
 * one) brings the images back.
 */
export function limitRequestImages(messages, maxImages) {
    const limit = Math.max(0, Math.floor(maxImages));
    const images = listRequestImages(messages);
    if (images.length <= limit)
        return { messages: [...messages], omittedCount: 0 };
    const omitted = new Set(images.slice(0, images.length - limit).map((image) => image.key));
    return {
        messages: replaceRequestImages(messages, (image) => omitted.has(image.key) ? omittedImageText(limit, image.path) : undefined),
        omittedCount: omitted.size,
    };
}
/**
 * Every image block of `messages` (user messages and tool results), oldest
 * first, with the file each one came from when the attachment reminder or the
 * producing tool call names it.
 */
export function listRequestImages(messages) {
    const toolCallPaths = collectToolCallPaths(messages);
    const images = [];
    messages.forEach((agentMessage, messageIndex) => {
        const message = agentMessage;
        const count = imageBlockCount(message);
        if (count === 0)
            return;
        const paths = imagePathsForMessage(message, count, toolCallPaths);
        let imageIndex = 0;
        message.content.forEach((block, blockIndex) => {
            if (!isImageBlock(block))
                return;
            const { data, mimeType } = block;
            const path = paths[imageIndex];
            imageIndex += 1;
            images.push({
                key: `${messageIndex}:${blockIndex}`,
                messageIndex,
                blockIndex,
                role: message.role,
                base64Bytes: typeof data === 'string' ? data.length : 0,
                ...(typeof mimeType === 'string' ? { mimeType } : {}),
                ...(path ? { path } : {}),
            });
        });
    });
    return images;
}
/**
 * Replace each image block for which `replacement` returns text with that
 * text block. Messages without a replaced image keep their identity.
 */
export function replaceRequestImages(messages, replacement) {
    const texts = new Map();
    for (const image of listRequestImages(messages)) {
        const text = replacement(image);
        if (text !== undefined)
            texts.set(image.key, text);
    }
    if (texts.size === 0)
        return [...messages];
    return messages.map((message, messageIndex) => {
        const blocks = message.content;
        if (!Array.isArray(blocks))
            return message;
        let changed = false;
        const content = blocks.map((block, blockIndex) => {
            const text = texts.get(`${messageIndex}:${blockIndex}`);
            if (text === undefined)
                return block;
            changed = true;
            return { type: 'text', text };
        });
        return changed ? { ...message, content } : message;
    });
}
function omittedImageText(limit, path) {
    const scope = `this request keeps only the ${limit} most recent images`;
    return path
        ? `[Earlier image omitted: ${scope}. Original file: ${path}]`
        : `[Earlier image omitted: ${scope}.]`;
}
function isImageBlock(block) {
    return (Boolean(block) && typeof block === 'object' && block.type === 'image');
}
function textOf(block) {
    if (!block || typeof block !== 'object')
        return undefined;
    const { type, text } = block;
    return type === 'text' && typeof text === 'string' ? text : undefined;
}
function imageBlockCount(message) {
    if (!Array.isArray(message.content))
        return 0;
    let count = 0;
    for (const block of message.content)
        if (isImageBlock(block))
            count += 1;
    return count;
}
const ATTACHMENT_TAG_OPEN = '<attachment';
const PATH_ARGUMENT_KEYS = ['path', 'file_path', 'filePath'];
function imagePathsForMessage(message, imageCount, toolCallPaths) {
    if (message.role === 'toolResult') {
        const path = toolCallPaths.get(message.toolCallId);
        return imageCount === 1 && path ? [path] : [];
    }
    if (message.role !== 'user' || !Array.isArray(message.content))
        return [];
    // Attachment reminders list every attachment of the message in order; inline
    // images are the ones sent as image blocks. Only trust the mapping when the
    // counts agree, otherwise fall back to a placeholder without a path.
    const inlineImagePaths = [];
    for (const block of message.content) {
        const text = textOf(block);
        if (text === undefined)
            continue;
        for (const attributes of attachmentTagAttributes(text)) {
            const path = attributes.get('path');
            if (attributes.get('inline') !== 'true' || !path)
                continue;
            const kind = attributes.get('kind');
            const mime = attributes.get('mime') ?? '';
            if (kind === 'image' || (kind === undefined && mime.startsWith('image/'))) {
                inlineImagePaths.push(path);
            }
        }
    }
    return inlineImagePaths.length === imageCount ? inlineImagePaths : [];
}
function collectToolCallPaths(messages) {
    const paths = new Map();
    for (const message of messages) {
        if (message.role !== 'assistant' || !Array.isArray(message.content))
            continue;
        for (const block of message.content) {
            if (!block ||
                typeof block !== 'object' ||
                block.type !== 'toolCall' ||
                !block.arguments ||
                typeof block.arguments !== 'object') {
                continue;
            }
            for (const key of PATH_ARGUMENT_KEYS) {
                const value = block.arguments[key];
                if (typeof value === 'string' && value.trim()) {
                    paths.set(block.id, value.trim());
                    break;
                }
            }
        }
    }
    return paths;
}
/**
 * Attributes of each `<attachment …>` tag in `text`. A linear scan rather than
 * a regular expression, because message text is user-controlled and nested
 * quantifiers over it can backtrack polynomially.
 */
function attachmentTagAttributes(text) {
    const tags = [];
    let from = 0;
    for (;;) {
        const start = text.indexOf(ATTACHMENT_TAG_OPEN, from);
        if (start < 0)
            break;
        const end = text.indexOf('>', start);
        // No later tag can be closed either.
        if (end < 0)
            break;
        const next = text.charAt(start + ATTACHMENT_TAG_OPEN.length);
        if (next === '>' || next === '/' || /\s/u.test(next)) {
            tags.push(parseTagAttributes(text.slice(start + ATTACHMENT_TAG_OPEN.length, end)));
        }
        from = end + 1;
    }
    return tags;
}
function parseTagAttributes(source) {
    const attributes = new Map();
    let position = 0;
    while (position < source.length) {
        const equals = source.indexOf('="', position);
        if (equals < 0)
            break;
        const close = source.indexOf('"', equals + 2);
        if (close < 0)
            break;
        let nameStart = equals;
        while (nameStart > position && isAttributeNameChar(source.charCodeAt(nameStart - 1))) {
            nameStart -= 1;
        }
        if (nameStart < equals) {
            attributes.set(source.slice(nameStart, equals), unescapeAttribute(source.slice(equals + 2, close)));
        }
        position = close + 1;
    }
    return attributes;
}
/** `[a-z_]`, matching the attribute names the attachment reminder writes. */
function isAttributeNameChar(code) {
    return (code >= 97 && code <= 122) || code === 95;
}
function unescapeAttribute(value) {
    return value
        .replaceAll('&quot;', '"')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}
//# sourceMappingURL=request-image-limit.js.map