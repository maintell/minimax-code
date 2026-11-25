/**
 * Feishu upload capability resolution: which endpoint, file type and message
 * type a given outbound media ref maps to, plus the safe filename and MIME
 * type the upload carries.
 *
 * Extracted from `feishu-sender.ts` to keep that file inside the package line
 * budget; re-exported there so existing import sites are unchanged.
 */
import { MIME_BY_EXTENSION } from '@mavis/shared';
const FEISHU_IMAGE_EXTENSIONS = new Set([
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'bmp',
    'ico',
    'tif',
    'tiff',
    'heic',
]);
const FEISHU_FILE_TYPE_BY_EXTENSION = {
    pdf: 'pdf',
    doc: 'doc',
    docx: 'doc',
    xls: 'xls',
    xlsx: 'xls',
    ppt: 'ppt',
    pptx: 'ppt',
};
const FEISHU_MIME_BY_EXTENSION = {
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    opus: 'audio/ogg',
};
const CANONICAL_EXTENSION_BY_MIME = {
    'text/html': 'html',
    'text/plain': 'txt',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/tiff': 'tiff',
    'image/heic': 'heic',
    'image/svg+xml': 'svg',
    'video/mp4': 'mp4',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/mpeg': 'mp3',
};
const FEISHU_GENERIC_MEDIA_TYPES = new Set(['image', 'audio', 'video', 'file', 'document']);
function extensionOf(value) {
    if (!value)
        return '';
    const withoutQuery = value.trim().split(/[?#]/u)[0] ?? '';
    const lastSegment = withoutQuery.split(/[\\/]/u).at(-1) ?? '';
    const dot = lastSegment.lastIndexOf('.');
    if (dot < 0 || dot === lastSegment.length - 1)
        return '';
    return lastSegment.slice(dot + 1).toLowerCase();
}
function decodeUriComponentSafely(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
function sanitizeBasename(value) {
    if (!value)
        return undefined;
    const withoutQuery = value.split(/[?#]/u)[0] ?? '';
    const lastSegment = withoutQuery
        .split(/[\\/]/u)
        .reverse()
        .find((segment) => segment.trim().length > 0);
    const sanitized = lastSegment
        ?.replace(/[\u0000-\u001f\u007f]/gu, '')
        .trim()
        .replace(/[.]+$/u, '')
        .trim();
    if (!sanitized || sanitized === '.' || sanitized === '..')
        return undefined;
    return sanitized;
}
function sourceBasename(path) {
    const trimmed = path.trim();
    let source = trimmed;
    if (/^(?:https?|file):\/\//iu.test(trimmed)) {
        try {
            source = new URL(trimmed).pathname;
        }
        catch {
            source = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
        }
    }
    return sanitizeBasename(decodeUriComponentSafely(source));
}
function typeExtension(type) {
    const normalized = type?.trim().toLowerCase().replace(/^\./u, '');
    if (!normalized || FEISHU_GENERIC_MEDIA_TYPES.has(normalized))
        return undefined;
    return Object.prototype.hasOwnProperty.call(MIME_BY_EXTENSION, normalized) ||
        Object.prototype.hasOwnProperty.call(FEISHU_MIME_BY_EXTENSION, normalized)
        ? normalized
        : undefined;
}
/** Resolve the safe Feishu transport filename without doing I/O. */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function resolveFeishuUploadFileName(ref) {
    const sourceName = sourceBasename(ref.path);
    const candidate = ref.nameSource === 'caption' || ref.nameSource === 'path'
        ? sourceName
        : (sanitizeBasename(ref.name) ?? sourceName);
    const baseName = candidate ?? 'attachment';
    if (extensionOf(baseName))
        return baseName;
    const extension = extensionOf(sourceName) ||
        typeExtension(ref.type) ||
        CANONICAL_EXTENSION_BY_MIME[ref.mimeType?.trim().toLowerCase() ?? ''] ||
        'bin';
    return `${baseName}.${extension}`;
}
/** Resolve Blob MIME extension-first, with only Feishu-specific overrides. */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function resolveFeishuUploadMimeType(ref, uploadFileName) {
    const extension = extensionOf(uploadFileName);
    return (FEISHU_MIME_BY_EXTENSION[extension] ??
        MIME_BY_EXTENSION[extension] ??
        ref.mimeType?.trim().toLowerCase() ??
        'application/octet-stream');
}
/** Resolve the exact Feishu upload endpoint/file type/message type whitelist. */
/** @public exercised directly by the colocated unit suite (v1 twin). */
export function resolveFeishuUploadSpec(uploadFileName) {
    const extension = extensionOf(uploadFileName);
    if (FEISHU_IMAGE_EXTENSIONS.has(extension)) {
        return {
            endpoint: 'images',
            fileTypeField: 'image_type',
            fileType: 'message',
            msgType: 'image',
            contentKey: 'image_key',
        };
    }
    if (extension === 'opus') {
        return {
            endpoint: 'files',
            fileTypeField: 'file_type',
            fileType: 'opus',
            msgType: 'audio',
            contentKey: 'file_key',
        };
    }
    if (extension === 'mp4') {
        return {
            endpoint: 'files',
            fileTypeField: 'file_type',
            fileType: 'mp4',
            msgType: 'media',
            contentKey: 'file_key',
        };
    }
    return {
        endpoint: 'files',
        fileTypeField: 'file_type',
        fileType: FEISHU_FILE_TYPE_BY_EXTENSION[extension] ?? 'stream',
        msgType: 'file',
        contentKey: 'file_key',
    };
}
//# sourceMappingURL=feishu-upload-spec.js.map