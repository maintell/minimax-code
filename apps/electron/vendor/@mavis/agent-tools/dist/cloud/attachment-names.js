/**
 * 云端附件的文件名与 MIME 规则，v1 AttachmentLoader 与 v2 cloud harness server 共用。
 *
 * 文件名优先使用上游透传的原始 `file_name`，旧消息缺失时才从 URL 回退；只保留 basename，
 * 去掉控制字符，UTF-8 超过 200 字节时截断并尽量保留扩展名。
 *
 * MIME 识别不盲信单一来源：文件名后缀优先，再用声明 mime_type / HTTP content-type 互相兜底，
 * 避免把 PDF/DOCX 等非媒体误当 image/video 发给模型。
 */
import { extname } from 'node:path';
/** URL 路径最后一段（解码后）；解析不出时为 `attachment.bin`。 */
export function deriveAttachmentFileName(url) {
    try {
        const parsed = new URL(url);
        const last = parsed.pathname.split('/').filter(Boolean).pop();
        if (!last)
            return 'attachment.bin';
        try {
            return decodeURIComponent(last);
        }
        catch {
            return last;
        }
    }
    catch {
        return 'attachment.bin';
    }
}
const GENERIC_MIME_TYPES = new Set([
    'application/octet-stream',
    'binary/octet-stream',
    'application/x-binary',
]);
function normalizeMimeType(value) {
    const normalized = value?.split(';', 1)[0]?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : undefined;
}
function isGenericMimeType(value) {
    return !value || GENERIC_MIME_TYPES.has(value);
}
function isMediaMimeType(value) {
    return value?.startsWith('image/') === true || value?.startsWith('video/') === true;
}
function inferMimeTypeFromName(fileName) {
    const normalized = fileName.trim().toLowerCase();
    if (!normalized)
        return undefined;
    if (normalized.endsWith('.png'))
        return 'image/png';
    if (normalized.endsWith('.jpg') || normalized.endsWith('.jpeg'))
        return 'image/jpeg';
    if (normalized.endsWith('.gif'))
        return 'image/gif';
    if (normalized.endsWith('.webp'))
        return 'image/webp';
    if (normalized.endsWith('.bmp'))
        return 'image/bmp';
    if (normalized.endsWith('.tif') || normalized.endsWith('.tiff'))
        return 'image/tiff';
    if (normalized.endsWith('.avif'))
        return 'image/avif';
    if (normalized.endsWith('.svg'))
        return 'image/svg+xml';
    if (normalized.endsWith('.mp4'))
        return 'video/mp4';
    if (normalized.endsWith('.mov') || normalized.endsWith('.qt'))
        return 'video/quicktime';
    if (normalized.endsWith('.mkv'))
        return 'video/x-matroska';
    if (normalized.endsWith('.webm'))
        return 'video/webm';
    if (normalized.endsWith('.flv'))
        return 'video/x-flv';
    if (normalized.endsWith('.avi'))
        return 'video/x-msvideo';
    if (normalized.endsWith('.pdf'))
        return 'application/pdf';
    if (normalized.endsWith('.rtf'))
        return 'application/rtf';
    if (normalized.endsWith('.doc'))
        return 'application/msword';
    if (normalized.endsWith('.docx')) {
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    }
    if (normalized.endsWith('.ppt'))
        return 'application/vnd.ms-powerpoint';
    if (normalized.endsWith('.pptx')) {
        return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    }
    if (normalized.endsWith('.xls'))
        return 'application/vnd.ms-excel';
    if (normalized.endsWith('.xlsx')) {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (normalized.endsWith('.odt'))
        return 'application/vnd.oasis.opendocument.text';
    if (normalized.endsWith('.odp'))
        return 'application/vnd.oasis.opendocument.presentation';
    if (normalized.endsWith('.ods'))
        return 'application/vnd.oasis.opendocument.spreadsheet';
    if (normalized.endsWith('.json'))
        return 'application/json';
    if (normalized.endsWith('.md') || normalized.endsWith('.markdown'))
        return 'text/markdown';
    if (normalized.endsWith('.txt'))
        return 'text/plain';
    if (normalized.endsWith('.csv'))
        return 'text/csv';
    if (normalized.endsWith('.tsv'))
        return 'text/tab-separated-values';
    if (normalized.endsWith('.html') || normalized.endsWith('.htm'))
        return 'text/html';
    return undefined;
}
export function resolveAttachmentMimeType(input) {
    const fromName = inferMimeTypeFromName(input.fileName);
    if (!isGenericMimeType(fromName))
        return fromName;
    const declared = normalizeMimeType(input.declaredMimeType);
    const response = normalizeMimeType(input.responseMimeType);
    // If the client says image/video but the storage response clearly says a
    // non-media type, prefer the response. This fail-closed branch prevents a
    // stale frontend `mime_type=image/*` from sending PDFs/Office files as image
    // content blocks to the model.
    if (isMediaMimeType(declared) && !isGenericMimeType(response) && !isMediaMimeType(response)) {
        return response;
    }
    if (!isGenericMimeType(declared))
        return declared;
    if (!isGenericMimeType(response))
        return response;
    return undefined;
}
const MAX_FILE_NAME_BYTES = 200;
/** 去掉路径和控制字符,保留 Unicode、空格与扩展名。 */
export function sanitizeAttachmentFileName(name) {
    const leaf = name.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
    const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '_');
    const safe = !cleaned || cleaned === '.' || cleaned === '..' ? 'attachment.bin' : cleaned;
    if (Buffer.byteLength(safe, 'utf8') <= MAX_FILE_NAME_BYTES)
        return safe;
    const extension = extname(safe);
    const retainedExtension = Buffer.byteLength(extension, 'utf8') <= 40 ? extension : '';
    const stem = retainedExtension ? safe.slice(0, -retainedExtension.length) : safe;
    return `${truncateUTF8(stem, MAX_FILE_NAME_BYTES - Buffer.byteLength(retainedExtension, 'utf8'))}${retainedExtension}`;
}
function truncateUTF8(value, maxBytes) {
    let output = '';
    let bytes = 0;
    for (const char of value) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (bytes + charBytes > maxBytes)
            break;
        output += char;
        bytes += charBytes;
    }
    return output;
}
//# sourceMappingURL=attachment-names.js.map