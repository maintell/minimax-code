const ELECTRON_NET_FETCH_BYTESTRING_CODE = 'ELECTRON_NET_FETCH_BYTESTRING';
export async function resolveInboundAttachments(envelope, downloader) {
    const refs = envelope.attachmentRefs ?? [];
    if (refs.length === 0 || !downloader)
        return [];
    const messageId = envelope.messageId ?? envelope.eventId ?? '';
    if (!messageId)
        return [];
    const sessionId = envelope.ctx.chatId || envelope.ctx.senderId || 'unknown';
    const settled = await Promise.allSettled(refs.map((ref) => downloader({ messageId, ref, sessionId })));
    const out = [];
    for (let i = 0; i < settled.length; i += 1) {
        out.push(settleDownloadedAttachment(settled[i], refs[i]));
    }
    return out;
}
/**
 * One settled download → attachment. A failed download degrades to a
 * text-only marker (error: 'download_failed'), except the Electron
 * net.fetch ByteString bug which must surface so the caller can retry
 * through the fallback transport.
 */
function settleDownloadedAttachment(result, ref) {
    if (result.status === 'fulfilled')
        return result.value;
    if (isElectronNetFetchByteStringError(result.reason))
        throw result.reason;
    return {
        type: ref.type === 'image' ? 'image' : 'file',
        filePath: '',
        fileName: ref.name ?? ref.key ?? 'attachment',
        mimeType: ref.mimeType ?? 'application/octet-stream',
        error: 'download_failed',
    };
}
export function isElectronNetFetchByteStringError(error) {
    return (!!error &&
        typeof error === 'object' &&
        error.code === ELECTRON_NET_FETCH_BYTESTRING_CODE);
}
//# sourceMappingURL=feishu-inbound-attachments.js.map