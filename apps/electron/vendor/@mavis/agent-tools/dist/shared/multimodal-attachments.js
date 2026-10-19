/**
 * Shared native multimodal attachment selection for local/cloud hosts.
 *
 * Hosts own IO (download, local asset registration, optional image
 * compression). This helper owns the provider-facing contract: supported MIME
 * allowlists, capability gates, and request/body caps. Keeping that logic here
 * prevents local-runtime and cloud-runtime from drifting on video/image
 * attachment behavior.
 */
const SUPPORTED_NATIVE_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
]);
const SUPPORTED_NATIVE_VIDEO_MIME_TYPES = new Set([
    'video/mp4',
    'video/x-msvideo',
    'video/quicktime',
    'video/x-matroska',
    'video/mkv',
]);
export function normaliseMultimodalMimeType(mime) {
    return mime?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
export function isSupportedNativeImageMime(mime) {
    return SUPPORTED_NATIVE_IMAGE_MIME_TYPES.has(normaliseMultimodalMimeType(mime));
}
export function isSupportedNativeVideoMime(mime) {
    return SUPPORTED_NATIVE_VIDEO_MIME_TYPES.has(normaliseMultimodalMimeType(mime));
}
export function nativeMultimodalKindForMime(mime) {
    const normalized = normaliseMultimodalMimeType(mime);
    if (isSupportedNativeImageMime(normalized))
        return 'image';
    if (isSupportedNativeVideoMime(normalized))
        return 'video';
    return undefined;
}
export function isMediaMime(mime) {
    const normalized = normaliseMultimodalMimeType(mime);
    return normalized.startsWith('image/') || normalized.startsWith('video/');
}
export function base64EncodedSize(rawBytes) {
    return Math.ceil(Math.max(0, rawBytes) / 3) * 4;
}
export function selectMultimodalAttachments(candidates, capabilities) {
    const kept = [];
    const demoted = [];
    const maxImage = numberCap(capabilities, 'max_image_bytes_inline');
    const maxVideo = numberCap(capabilities, 'max_video_bytes_inline');
    const maxBody = numberCap(capabilities, 'max_request_body_bytes');
    const maxCount = integerCap(capabilities, 'max_attachments_count');
    let runningBase64Bytes = 0;
    for (const candidate of candidates) {
        const mime = normaliseMultimodalMimeType(candidate.mime);
        const kind = nativeMultimodalKindForMime(mime);
        const base64SizeBytes = base64EncodedSize(candidate.sizeBytes);
        if (!kind) {
            demoted.push({ candidate, reason: 'unsupported_mime', mime, base64SizeBytes });
            continue;
        }
        if (kind === 'image' && capabilities?.support_image !== true) {
            demoted.push({ candidate, reason: 'unsupported_model', kind, mime, base64SizeBytes });
            continue;
        }
        if (kind === 'video' && capabilities?.support_video !== true) {
            demoted.push({ candidate, reason: 'unsupported_model', kind, mime, base64SizeBytes });
            continue;
        }
        if (kind === 'image' && maxImage > 0 && candidate.sizeBytes > maxImage) {
            demoted.push({
                candidate,
                reason: 'max_image_bytes_inline',
                kind,
                mime,
                base64SizeBytes,
                capBytes: maxImage,
            });
            continue;
        }
        if (kind === 'video' && maxVideo > 0 && candidate.sizeBytes > maxVideo) {
            demoted.push({
                candidate,
                reason: 'max_video_bytes_inline',
                kind,
                mime,
                base64SizeBytes,
                capBytes: maxVideo,
            });
            continue;
        }
        if (maxCount > 0 && kept.length >= maxCount) {
            demoted.push({
                candidate,
                reason: 'max_attachments_count',
                kind,
                mime,
                base64SizeBytes,
                capBytes: maxCount,
            });
            continue;
        }
        if (maxBody > 0 && runningBase64Bytes + base64SizeBytes > maxBody) {
            demoted.push({
                candidate,
                reason: 'max_request_body_bytes',
                kind,
                mime,
                base64SizeBytes,
                capBytes: maxBody,
            });
            continue;
        }
        kept.push({ candidate, kind, mime, base64SizeBytes });
        runningBase64Bytes += base64SizeBytes;
    }
    return { kept, demoted };
}
export function multimodalDemotionReasonCounts(demoted) {
    const counts = new Map();
    for (const item of demoted)
        counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    return counts;
}
export function multimodalDemotionTextNotes(demoted) {
    if (demoted.length === 0)
        return [];
    const counts = multimodalDemotionReasonCounts(demoted);
    const notes = [];
    const unsupported = counts.get('unsupported_model') ?? 0;
    if (unsupported > 0) {
        notes.push(`[Note: ${unsupported} media attachment(s) were received but the current model cannot view their modality. Ask the user for a text description if needed.]`);
    }
    const capped = (counts.get('max_image_bytes_inline') ?? 0) +
        (counts.get('max_video_bytes_inline') ?? 0) +
        (counts.get('max_attachments_count') ?? 0) +
        (counts.get('max_request_body_bytes') ?? 0);
    if (capped > 0) {
        notes.push(`[Note: ${capped} media attachment(s) exceeded the current model's inline media limits and were left as file references.]`);
    }
    return notes;
}
export function multimodalDemotionReferences(demoted) {
    return demoted
        .filter((item) => item.reason !== 'unsupported_mime')
        .map((item) => ({
        fileName: item.candidate.fileName || item.candidate.filePath?.split('/').pop() || 'attachment',
        mime: item.mime || normaliseMultimodalMimeType(item.candidate.mime),
        reason: item.reason,
        ...(item.candidate.filePath ? { filePath: item.candidate.filePath } : {}),
    }));
}
export function renderMultimodalDemotionReference(ref) {
    const attrs = [
        `name="${escapeAttachmentAttr(ref.fileName)}"`,
        `mime="${escapeAttachmentAttr(ref.mime)}"`,
        `reason="${escapeAttachmentAttr(ref.reason)}"`,
    ];
    return [
        `<attachment ${attrs.join(' ')}>`,
        ref.filePath
            ? `Media attachment was not sent inline. Local path: ${ref.filePath}`
            : 'Media attachment was not sent inline.',
        '</attachment>',
    ].join('\n');
}
function escapeAttachmentAttr(value) {
    return value.replace(/[&"]/g, (char) => (char === '&' ? '&amp;' : '&quot;'));
}
function numberCap(capabilities, key) {
    const value = capabilities?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
    }
    return 0;
}
function integerCap(capabilities, key) {
    const value = numberCap(capabilities, key);
    return Number.isInteger(value) ? value : 0;
}
//# sourceMappingURL=multimodal-attachments.js.map