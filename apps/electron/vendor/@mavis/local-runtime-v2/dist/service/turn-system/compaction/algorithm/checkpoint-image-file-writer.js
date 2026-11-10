/**
 * Saves history images to the Session artifacts so a checkpoint summary
 * request can carry a line naming the file instead of the image itself.
 */
export class CheckpointImageFileWriter {
    options;
    constructor(options) {
        this.options = options;
    }
    /**
     * Writes an image of a tool result or user message to the Session artifacts;
     * `undefined` when it cannot. A user image is keyed by its message position,
     * as user messages have no call id.
     */
    async writeImageFile(input, image) {
        const message = input.messages[image.messageIndex];
        if (!this.options.writeImageArtifact)
            return undefined;
        if (message?.role !== 'toolResult' && message?.role !== 'user')
            return undefined;
        const block = Array.isArray(message.content) ? message.content[image.blockIndex] : undefined;
        if (block?.type !== 'image')
            return undefined;
        const owner = message.role === 'toolResult'
            ? { toolCallId: message.toolCallId, toolName: message.toolName }
            : { toolCallId: `user-${image.messageIndex}`, toolName: 'user' };
        try {
            const artifact = await this.options.writeImageArtifact({
                sessionId: input.sessionId,
                ...owner,
                data: block.data,
                mimeType: block.mimeType,
            });
            const reference = artifact.reference.trim();
            return reference || undefined;
        }
        catch (error) {
            try {
                this.options.logger?.error?.({
                    event: 'context_image_artifact_failed',
                    session_id: input.sessionId,
                    tool_name: owner.toolName,
                    reason: safeErrorReason(error),
                }, '[local-runtime-v2] checkpoint image file');
            }
            catch {
                // Diagnostics must never change context compaction.
            }
            return undefined;
        }
    }
}
function safeErrorReason(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (typeof code === 'string' && code.trim())
        return code.trim();
    return error instanceof Error && error.name ? error.name : 'unknown_error';
}
//# sourceMappingURL=checkpoint-image-file-writer.js.map