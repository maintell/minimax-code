/**
 * Resolve every `envelope.attachmentRefs` entry to an absolute on-disk
 * file via the adapter's `downloadAttachmentToLocal`. Per-ref failures
 * degrade to a `download_failed` marker attachment so the rest of the
 * batch still reaches the agent. Returns `[]` when there are no refs or
 * the adapter does not implement `downloadAttachmentToLocal`.
 *
 * Lifted out of `telegram-adapter-routes.ts` so both the webhook route
 * and the long-poll wire dispatch the same multimodal pipeline (the
 * poll wire previously dropped attachments silently).
 */
export async function downloadAttachmentsForUnifiedInbound(adapter, envelope) {
    const refs = envelope.attachmentRefs ?? [];
    if (refs.length === 0 || !adapter.downloadAttachmentToLocal)
        return [];
    const messageId = envelope.messageId ?? envelope.eventId;
    const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
    const settled = await Promise.allSettled(refs.map((ref) => adapter.downloadAttachmentToLocal({
        clientName: adapter.clientName,
        ref,
        ...(messageId ? { messageId } : {}),
        sessionId,
    })));
    const out = [];
    for (let i = 0; i < settled.length; i += 1) {
        out.push(settleUnifiedDownload(settled[i], refs[i]));
    }
    return out;
}
/** One settled download → attachment; failures degrade to a marker row. */
function settleUnifiedDownload(r, ref) {
    if (r.status === 'fulfilled') {
        return {
            type: r.value.type,
            filePath: r.value.filePath,
            fileName: r.value.fileName,
            mimeType: r.value.mimeType,
            ...(r.value.error ? { error: r.value.error } : {}),
        };
    }
    return {
        type: ref.type === 'image' ? 'image' : 'file',
        filePath: '',
        fileName: ref.name ?? ref.key ?? 'attachment',
        mimeType: ref.mimeType ?? 'application/octet-stream',
        error: 'download_failed',
    };
}
/**
 * Inject a short Chinese placeholder text when an inbound message has only
 * attachments and no body text — keeps the agent loop's text-first
 * assumptions intact ("the user sent something" instead of an empty turn).
 */
export function ensureUnifiedInboundText(text, refs) {
    if (text.trim())
        return text;
    if (!refs || refs.length === 0)
        return text;
    const primary = refs[0];
    if (primary.type === 'image')
        return '[图片]';
    if (primary.type === 'audio')
        return '[语音]';
    if (primary.type === 'video')
        return '[视频]';
    return `[文件] ${primary.name ?? primary.key ?? ''}`.trim();
}
//# sourceMappingURL=telegram-adapter-shared.js.map