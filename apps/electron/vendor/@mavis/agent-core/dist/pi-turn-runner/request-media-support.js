// Wording mirrors pi-ai's own non-vision placeholders (transform-messages.ts),
// so a text-only target sees the same text whichever layer replaced the image.
const USER_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
const TOOL_IMAGE_PLACEHOLDER = '(tool image omitted: model does not support images)';
const USER_VIDEO_PLACEHOLDER = '(video omitted: model does not support video)';
const TOOL_VIDEO_PLACEHOLDER = '(tool video omitted: model does not support video)';
/**
 * Image and video support of `model`: explicit flags first, else its pi-ai input
 * modalities. A model object without `input` (partial models built outside the
 * resolver) declares nothing, so its media passes through unchanged.
 */
export function resolveRequestMediaSupport(model) {
    const declared = model;
    const input = model.input;
    const acceptsImageBlocks = Array.isArray(input) ? input.includes('image') : true;
    return {
        image: declared.supportsImageInput ?? acceptsImageBlocks,
        video: declared.supportsVideoInput ?? acceptsImageBlocks,
    };
}
/**
 * Replace every image block of a user message or tool result that the target
 * cannot accept with a text placeholder, on the temporary request copy only.
 * Blocks with a `video/*` mimeType are videos and follow video support; every
 * other image block follows image support. Consecutive identical placeholders
 * collapse into one, as pi-ai does. Messages without a replaced block keep
 * their identity, so the projection is deterministic for prefix caching.
 */
export function projectUnsupportedMediaBlocks(message, support) {
    if (support.image && support.video)
        return message;
    if (message.role !== 'user' && message.role !== 'toolResult')
        return message;
    if (typeof message.content === 'string')
        return message;
    const isTool = message.role === 'toolResult';
    let changed = false;
    const content = [];
    for (const block of message.content) {
        const placeholder = unsupportedPlaceholder(block, support, isTool);
        if (placeholder === undefined) {
            content.push(block);
            continue;
        }
        changed = true;
        const previous = content.at(-1);
        if (previous?.type === 'text' && previous.text === placeholder)
            continue;
        content.push({ type: 'text', text: placeholder });
    }
    return changed ? { ...message, content } : message;
}
function unsupportedPlaceholder(block, support, isTool) {
    if (block.type !== 'image')
        return undefined;
    // Persisted history is not schema-checked; a block without a mimeType is
    // treated as a still image rather than crashing every later request.
    const mimeType = block.mimeType;
    const normalized = typeof mimeType === 'string' ? mimeType.toLowerCase() : '';
    if (normalized.startsWith('video/')) {
        if (support.video)
            return undefined;
        return isTool ? TOOL_VIDEO_PLACEHOLDER : USER_VIDEO_PLACEHOLDER;
    }
    // Audio and PDF also ride on `image` blocks but are not still images: the
    // outbound projection decides them by protocol before this filter runs.
    if (normalized.startsWith('audio/') || normalized === 'application/pdf')
        return undefined;
    if (support.image)
        return undefined;
    return isTool ? TOOL_IMAGE_PLACEHOLDER : USER_IMAGE_PLACEHOLDER;
}
//# sourceMappingURL=request-media-support.js.map