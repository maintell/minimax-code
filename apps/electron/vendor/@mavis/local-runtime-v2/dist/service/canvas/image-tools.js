import { basename, extname } from 'node:path';
import { CanvasServiceError } from './contracts.js';
/**
 * Local guard only: avoids uploading very large files. Upstream enforces its own size and
 * resolution limits per tool and its rejection message is surfaced as-is.
 */
const CANVAS_IMAGE_TOOL_MAX_BYTES = 30 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    bmp: 'image/bmp',
    tif: 'image/tiff',
    tiff: 'image/tiff',
};
const EXTENSION_BY_IMAGE_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
};
/** Input formats and rejection message of each Canvas cloud image tool. */
const CANVAS_IMAGE_TOOLS = {
    removeBackground: {
        mimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff'],
        unsupportedMessage: 'Only PNG, JPEG, WebP, BMP and TIFF images support background removal',
    },
    enhance: {
        mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        unsupportedMessage: 'Only PNG, JPEG and WebP images support enhancement',
    },
};
/** Returns the canonical image MIME type, or throws when the tool does not accept the node. */
export function requireSupportedCanvasImage(tool, node, sizeBytes) {
    const accepted = CANVAS_IMAGE_TOOLS[tool].mimeTypes;
    const declared = node.file.mimeType?.split(';', 1)[0]?.trim().toLowerCase();
    const extension = extname(node.file.fileName ?? node.file.relativePath)
        .slice(1)
        .toLowerCase();
    const mimeType = [declared, IMAGE_MIME_BY_EXTENSION[extension]].find((candidate) => candidate !== undefined && accepted.includes(candidate));
    if (!mimeType) {
        throw new CanvasServiceError('UNSUPPORTED_MEDIA', CANVAS_IMAGE_TOOLS[tool].unsupportedMessage);
    }
    if (sizeBytes > CANVAS_IMAGE_TOOL_MAX_BYTES) {
        throw new CanvasServiceError('UNSUPPORTED_MEDIA', 'Image is larger than 30 MB');
    }
    return mimeType;
}
function canvasImageStem(node) {
    const original = basename(node.file.fileName ?? node.file.relativePath);
    return original.slice(0, original.length - extname(original).length) || 'image';
}
/** `photo.jpg` → `photo-no-bg.png`. */
export function canvasImageBackgroundOutputName(node) {
    return `${canvasImageStem(node)}-no-bg.png`;
}
/**
 * `photo.jpeg` → `photo-hd.jpeg`. The output keeps the input format, so the original
 * extension is kept when it matches the result MIME type reported by the cloud tool;
 * otherwise the extension follows that MIME type.
 */
export function canvasImageEnhanceOutputName(node, mimeType) {
    const original = extname(node.file.fileName ?? node.file.relativePath).slice(1);
    const extension = original && IMAGE_MIME_BY_EXTENSION[original.toLowerCase()] === mimeType
        ? original
        : (EXTENSION_BY_IMAGE_MIME[mimeType] ?? (original || 'png'));
    return `${canvasImageStem(node)}-hd.${extension}`;
}
/** Normalizes a reported result MIME type to one of the enhance output formats. */
export function canvasImageEnhanceResultMimeType(reported, sourceMimeType) {
    const normalized = reported?.split(';', 1)[0]?.trim().toLowerCase();
    return normalized && EXTENSION_BY_IMAGE_MIME[normalized] ? normalized : sourceMimeType;
}
//# sourceMappingURL=image-tools.js.map