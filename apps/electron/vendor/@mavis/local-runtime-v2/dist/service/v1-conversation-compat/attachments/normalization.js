import { isInlineDisplayDataUrl } from '../../session-system/index.js';
export function needsAttachmentRegistration(attachment) {
    // 本地路径可能由调用方临时持有，接纳前必须交给资产层持久化或复用已有资产。
    return Boolean(attachment.filePath?.trim()) || isInlineDisplayDataUrl(attachment.dataUrl);
}
export function requireRegisteredAttachment(attachment, index) {
    if (!attachment?.filePath?.trim() || isInlineDisplayDataUrl(attachment.dataUrl)) {
        throw new TypeError(`Attachment registration returned an invalid result at index ${String(index)}.`);
    }
    const safeAttachment = { ...attachment };
    delete safeAttachment.registrationReceipt;
    return withoutInlineDataUrl(safeAttachment);
}
export function withoutInlineDataUrl(attachment) {
    if (!isInlineDisplayDataUrl(attachment.dataUrl))
        return attachment;
    const sanitized = { ...attachment };
    delete sanitized.dataUrl;
    return sanitized;
}
//# sourceMappingURL=normalization.js.map