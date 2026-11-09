/**
 * Shared native multimodal attachment selection for local/cloud hosts.
 *
 * Hosts own IO (download, local asset registration). This helper owns the
 * provider-facing contract: supported MIME allowlists, capability gates,
 * request/body caps, and the image encoding inline attachments share with
 * tool result images. Keeping that logic here prevents local-runtime and
 * cloud-runtime from drifting on video/image attachment behavior.
 */
import { encodeRequestImageDetails, } from '@mavis/context-manager';
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
/**
 * Audio MIME types Gemini reads inline, keyed by the aliases clients send.
 * Values are the spellings Gemini documents, so the request never carries an
 * alias the provider may reject.
 */
const NATIVE_AUDIO_MIME_ALIASES = new Map([
    ['audio/wav', 'audio/wav'],
    ['audio/x-wav', 'audio/wav'],
    ['audio/wave', 'audio/wav'],
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/mp3', 'audio/mpeg'],
    ['audio/aiff', 'audio/aiff'],
    ['audio/x-aiff', 'audio/aiff'],
    ['audio/aac', 'audio/aac'],
    ['audio/ogg', 'audio/ogg'],
    ['audio/opus', 'audio/opus'],
    ['audio/flac', 'audio/flac'],
    ['audio/x-flac', 'audio/flac'],
    ['audio/m4a', 'audio/m4a'],
    ['audio/x-m4a', 'audio/m4a'],
    ['audio/mp4', 'audio/m4a'],
    ['audio/webm', 'audio/webm'],
]);
const NATIVE_PDF_MIME_TYPE = 'application/pdf';
/** Extensions of the inline audio formats, mapped to their canonical MIME. */
const NATIVE_AUDIO_EXTENSION_MIME = new Map([
    ['wav', 'audio/wav'],
    ['mp3', 'audio/mpeg'],
    ['aif', 'audio/aiff'],
    ['aiff', 'audio/aiff'],
    ['aac', 'audio/aac'],
    ['ogg', 'audio/ogg'],
    ['oga', 'audio/ogg'],
    ['opus', 'audio/opus'],
    ['flac', 'audio/flac'],
    ['m4a', 'audio/m4a'],
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
/** Canonical inline audio MIME for `mime`, or `undefined` when audio is not inlineable. */
export function nativeAudioMime(mime) {
    return NATIVE_AUDIO_MIME_ALIASES.get(normaliseMultimodalMimeType(mime));
}
/** Canonical inline audio MIME for a file extension (without the dot). */
export function nativeAudioMimeForExtension(extension) {
    return NATIVE_AUDIO_EXTENSION_MIME.get(extension.toLowerCase().replace(/^\./u, ''));
}
export function isSupportedNativePdfMime(mime) {
    return normaliseMultimodalMimeType(mime) === NATIVE_PDF_MIME_TYPE;
}
export function nativeMultimodalKindForMime(mime) {
    const normalized = normaliseMultimodalMimeType(mime);
    if (isSupportedNativeImageMime(normalized))
        return 'image';
    if (isSupportedNativeVideoMime(normalized))
        return 'video';
    if (nativeAudioMime(normalized))
        return 'audio';
    if (isSupportedNativePdfMime(normalized))
        return 'pdf';
    return undefined;
}
export function isMediaMime(mime) {
    const normalized = normaliseMultimodalMimeType(mime);
    return normalized.startsWith('image/') || normalized.startsWith('video/');
}
export function base64EncodedSize(rawBytes) {
    return Math.ceil(Math.max(0, rawBytes) / 3) * 4;
}
/**
 * Encode an inline image attachment like a tool result image, so it fits every
 * provider the session may switch to. `undefined` keeps the original bytes;
 * `'undecodable'` means the bytes must not be inlined.
 */
export function encodeAttachmentImage(bytes, mime, encoding) {
    return encodeRequestImageDetails(bytes, mime, encoding);
}
const KIND_SUPPORT = {
    image: 'support_image',
    video: 'support_video',
    audio: 'support_audio',
    pdf: 'support_pdf',
};
const KIND_SIZE_CAP = {
    image: 'max_image_bytes_inline',
    video: 'max_video_bytes_inline',
    audio: 'max_audio_bytes_inline',
    pdf: 'max_pdf_bytes_inline',
};
/** Kinds only an opted-in transport carries; elsewhere they stay plain file references. */
const OPT_IN_KINDS = new Set(['audio', 'pdf']);
export function selectMultimodalAttachments(candidates, capabilities) {
    const kept = [];
    const demoted = [];
    const maxBody = numberCap(capabilities, 'max_request_body_bytes');
    const maxCount = integerCap(capabilities, 'max_attachments_count');
    let runningBase64Bytes = 0;
    for (const candidate of candidates) {
        const normalized = normaliseMultimodalMimeType(candidate.mime);
        const kind = nativeMultimodalKindForMime(normalized);
        const mime = kind === 'audio' ? (nativeAudioMime(normalized) ?? normalized) : normalized;
        const base64SizeBytes = base64EncodedSize(candidate.sizeBytes);
        if (!kind) {
            demoted.push({ candidate, reason: 'unsupported_mime', mime, base64SizeBytes });
            continue;
        }
        if (capabilities?.[KIND_SUPPORT[kind]] !== true) {
            // Audio and PDF were never media for models without the opt-in, so keep
            // reporting them as ordinary files instead of an unreadable modality.
            if (OPT_IN_KINDS.has(kind)) {
                demoted.push({ candidate, reason: 'unsupported_mime', mime, base64SizeBytes });
            }
            else {
                demoted.push({ candidate, reason: 'unsupported_model', kind, mime, base64SizeBytes });
            }
            continue;
        }
        const sizeCapReason = KIND_SIZE_CAP[kind];
        const maxSize = numberCap(capabilities, sizeCapReason);
        if (maxSize > 0 && candidate.sizeBytes > maxSize) {
            demoted.push({
                candidate,
                reason: sizeCapReason,
                kind,
                mime,
                base64SizeBytes,
                capBytes: maxSize,
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
        (counts.get('max_audio_bytes_inline') ?? 0) +
        (counts.get('max_pdf_bytes_inline') ?? 0) +
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