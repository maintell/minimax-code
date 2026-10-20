import { canRecoverByDroppingImages, encodeRequestImageBlocks, } from '@mavis/context-manager';
/**
 * Keeps request media within provider limits: re-encodes tool result images to
 * the per-image limit, and asks the turn to repeat a request the provider
 * rejected for its size or images once, after compaction archives the older
 * images.
 */
export function requestMediaExtension(options = {}) {
    const afterToolCall = async (toolContext) => {
        const content = await encodeRequestImageBlocks(toolContext.result.content, options.getImageEncoding?.());
        return content ? { content } : undefined;
    };
    const afterLlmCall = (event) => canRecoverByDroppingImages(event.message, event.messages)
        ? { type: 'recover', reason: 'request_media' }
        : { type: 'continue' };
    return {
        id: options.id ?? 'request-media',
        description: options.description ??
            'Re-encode tool result images and recover once from a request rejected for its media.',
        init(pi) {
            pi.on('after_tool_call', afterToolCall);
            pi.on('after_llm_call', afterLlmCall);
        },
    };
}
//# sourceMappingURL=request-media.js.map