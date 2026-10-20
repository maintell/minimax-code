import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { isSupportedNativeVideoMime, normaliseMultimodalMimeType, inferReadVideoMimeType, selectMultimodalAttachments, } from '@mavis/agent-tools';
import { buildCompressedModelImageFromBuffer, buildPassthroughModelJpegFilePart, MODEL_IMAGE_MAX_BYTES, } from '../utils/model-image-preprocess.js';
import { normalizeSupportedNativeImageMime, resolveNativeImageMime } from './native-image-mime.js';
export const LOCAL_USER_IMAGE_MAX_BASE64_BODY_BYTES = 512 * 1024;
const COMPRESSIBLE_MODEL_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg']);
export async function loadUserImages(attachments, options = {}) {
    const imageAttachments = attachments.filter((a) => resolveNativeImageMime(a));
    if (imageAttachments.length === 0)
        return undefined;
    const maxBytes = options.maxBytesPerImage ?? maxModelImageBytesForBatch(imageAttachments.length);
    const images = [];
    for (const attachment of imageAttachments) {
        const image = await loadUserImage(attachment, maxBytes);
        if (image)
            images.push(image);
    }
    return images.length > 0 ? images : undefined;
}
export async function loadUserImagesForMessages(rawMessages, registeredMessages) {
    const modelImageMessages = mergeTransientImageAttachments(rawMessages, registeredMessages);
    const modelImageCount = modelImageMessages.reduce((total, message) => total + message.attachments.filter((att) => resolveNativeImageMime(att)).length, 0);
    const maxBytesPerImage = maxModelImageBytesForBatch(modelImageCount);
    const imageGroups = await Promise.all(modelImageMessages.map((message) => loadUserImages(message.attachments, { maxBytesPerImage })));
    const images = imageGroups.flatMap((group) => group ?? []);
    return images.length > 0 ? images : undefined;
}
export async function loadUserMediaCandidatesForMessages(rawMessages, registeredMessages, options = {}) {
    const modelImageMessages = mergeTransientImageAttachments(rawMessages, registeredMessages);
    const modelImageCount = modelImageMessages.reduce((total, message) => total + message.attachments.filter((att) => resolveNativeImageMime(att)).length, 0);
    const maxBytesPerImage = options.maxBytesPerImage ?? maxModelImageBytesForBatch(modelImageCount);
    const media = [];
    for (const [messageIndex, message] of registeredMessages.entries()) {
        const modelImageMessage = modelImageMessages[messageIndex];
        for (const [attachmentIndex, attachment] of message.attachments.entries()) {
            const imageAttachment = modelImageMessage?.attachments[attachmentIndex] ?? attachment;
            const image = await loadUserImage(imageAttachment, maxBytesPerImage, options.capabilities, options.preprocessImages ?? true);
            if (image) {
                media.push(image);
                continue;
            }
            const video = await loadUserVideo(attachment);
            if (video)
                media.push(video);
        }
    }
    return media.length > 0 ? media : undefined;
}
export function maxModelImageBytesForBatch(imageCount) {
    if (imageCount <= 0)
        return MODEL_IMAGE_MAX_BYTES;
    const perImageBase64Budget = Math.floor(LOCAL_USER_IMAGE_MAX_BASE64_BODY_BYTES / imageCount);
    const perImageRawBudget = Math.floor(perImageBase64Budget / 4) * 3;
    return Math.min(MODEL_IMAGE_MAX_BYTES, Math.max(1, perImageRawBudget));
}
async function loadUserImage(attachment, maxBytes, capabilities, preprocess = true) {
    try {
        const nativeMime = resolveNativeImageMime(attachment);
        if (!nativeMime)
            return undefined;
        const inlineDataUrl = attachment.dataUrl?.startsWith('data:') ? attachment.dataUrl : undefined;
        const decoded = inlineDataUrl ? decodeDataUrl(inlineDataUrl) : null;
        if (decoded && inlineDataUrl) {
            const fileName = attachment.fileName || (attachment.filePath ? basename(attachment.filePath) : 'image.jpg');
            const sourceCandidate = sourceImageCandidate(attachment, nativeMime, decoded.buffer.byteLength, fileName);
            if (!preprocess) {
                return attachment.filePath
                    ? sourceCandidate
                    : { ...sourceCandidate, data: decoded.buffer.toString('base64') };
            }
            if (shouldDeferImageBeforePreprocessing(sourceCandidate, nativeMime, capabilities)) {
                return sourceCandidate;
            }
            const passthrough = buildPassthroughModelJpegFilePart(decoded, fileName, inlineDataUrl, {
                maxBytes,
            });
            const compressed = passthrough
                ? undefined
                : buildCompressedModelImageSafely(decoded.buffer, fileName, attachment.filePath, {
                    maxBytes,
                });
            const prepared = passthrough
                ? toImageContent(passthrough.url, passthrough.mime, fileName, attachment.filePath)
                : compressed
                    ? toImageContent(compressed.filePart.url, compressed.filePart.mime, fileName, attachment.filePath)
                    : passthroughImageBytes(decoded.buffer, nativeMime, maxBytes, fileName, attachment.filePath);
            return (prepared ??
                (shouldDeferImageRead(sourceCandidate, capabilities) ? sourceCandidate : undefined));
        }
        if (!attachment.filePath)
            return undefined;
        const info = await stat(attachment.filePath);
        if (!info.isFile())
            return undefined;
        const fileName = attachment.fileName || basename(attachment.filePath);
        const sourceCandidate = sourceImageCandidate(attachment, nativeMime, info.size, fileName);
        if (!preprocess)
            return sourceCandidate;
        if (shouldDeferImageBeforePreprocessing(sourceCandidate, nativeMime, capabilities)) {
            return sourceCandidate;
        }
        const bytes = await readFile(attachment.filePath);
        const image = buildCompressedModelImageSafely(bytes, fileName, attachment.filePath, {
            maxBytes,
        });
        const prepared = image
            ? toImageContent(image.filePart.url, image.filePart.mime, fileName, attachment.filePath)
            : passthroughImageBytes(bytes, nativeMime, maxBytes, fileName, attachment.filePath);
        return (prepared ??
            (shouldDeferImageRead(sourceCandidate, capabilities) ? sourceCandidate : undefined));
    }
    catch {
        // Keep the local turn alive if one attachment is no longer readable.
        return undefined;
    }
}
function buildCompressedModelImageSafely(bytes, fileName, filePath, options) {
    try {
        return buildCompressedModelImageFromBuffer(bytes, fileName, filePath, options);
    }
    catch {
        return null;
    }
}
function shouldDeferImageBeforePreprocessing(candidate, mimeType, capabilities) {
    return (!COMPRESSIBLE_MODEL_IMAGE_MIME_TYPES.has(mimeType.toLowerCase()) &&
        shouldDeferImageRead(candidate, capabilities));
}
function sourceImageCandidate(attachment, mime, sizeBytes, fileName) {
    return {
        id: attachment.assetId ?? attachment.filePath ?? `image:${fileName}:${sizeBytes}`,
        kind: 'image',
        mime: normaliseMultimodalMimeType(mime),
        sizeBytes,
        fileName,
        ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
    };
}
function shouldDeferImageRead(candidate, capabilities) {
    if (!capabilities)
        return false;
    return (selectMultimodalAttachments([candidate], {
        support_image: capabilities.support_image,
        max_image_bytes_inline: capabilities.max_image_bytes_inline,
    }).kept.length === 0);
}
function toImageContent(dataUrl, mimeType, fileName, filePath) {
    const decoded = decodeDataUrl(dataUrl);
    if (!decoded)
        return undefined;
    return {
        id: `image:data:${decoded.buffer.byteLength}:${decoded.buffer.subarray(0, 16).toString('base64')}`,
        kind: 'image',
        data: decoded.buffer.toString('base64'),
        mime: normaliseMultimodalMimeType(mimeType),
        sizeBytes: decoded.buffer.byteLength,
        fileName,
        ...(filePath ? { filePath } : {}),
    };
}
function passthroughImageBytes(bytes, mimeType, maxBytes, fileName = 'image', filePath) {
    if (!normalizeSupportedNativeImageMime(mimeType) ||
        COMPRESSIBLE_MODEL_IMAGE_MIME_TYPES.has(normalizeSupportedNativeImageMime(mimeType) ?? '') ||
        bytes.byteLength > maxBytes) {
        return undefined;
    }
    return {
        id: `image:bytes:${bytes.byteLength}:${bytes.subarray(0, 16).toString('base64')}`,
        kind: 'image',
        data: bytes.toString('base64'),
        mime: normaliseMultimodalMimeType(mimeType),
        sizeBytes: bytes.byteLength,
        fileName,
        ...(filePath ? { filePath } : {}),
    };
}
async function loadUserVideo(attachment) {
    const mime = resolveNativeVideoMime(attachment);
    if (!isSupportedNativeVideoMime(mime))
        return undefined;
    if (!attachment.filePath)
        return undefined;
    try {
        const info = await stat(attachment.filePath);
        if (!info.isFile())
            return undefined;
        return {
            id: attachment.assetId ?? attachment.filePath,
            kind: 'video',
            mime,
            sizeBytes: info.size,
            fileName: attachment.fileName || basename(attachment.filePath),
            filePath: attachment.filePath,
        };
    }
    catch {
        // Keep the local turn alive if one attachment is no longer readable.
        return undefined;
    }
}
export function resolveNativeVideoMime(attachment) {
    const explicitMime = normaliseMultimodalMimeType(attachment.mimeType);
    if (isSupportedNativeVideoMime(explicitMime))
        return explicitMime;
    return normaliseMultimodalMimeType(inferReadVideoMimeType(attachment.fileName) || inferReadVideoMimeType(attachment.filePath));
}
function mergeTransientImageAttachments(rawMessages, registeredMessages) {
    return registeredMessages.map((message, messageIndex) => {
        const rawAttachments = rawMessages[messageIndex]?.attachments ?? [];
        return {
            ...message,
            attachments: message.attachments.map((attachment, attachmentIndex) => {
                const rawAttachment = normalizeTransientAttachment(rawAttachments[attachmentIndex]);
                if (!rawAttachment || !isImageAttachment(rawAttachment))
                    return attachment;
                return {
                    ...attachment,
                    type: 'image',
                    ...(rawAttachment.dataUrl ? { dataUrl: rawAttachment.dataUrl } : {}),
                    fileName: rawAttachment.fileName || attachment.fileName,
                    mimeType: rawAttachment.mimeType || attachment.mimeType,
                };
            }),
        };
    });
}
/** Normalize persisted display-era aliases before transient data reaches model media handling. */
function normalizeTransientAttachment(value) {
    if (!isRecord(value))
        return undefined;
    const type = readAttachmentString(value, ['type']);
    const filePath = readAttachmentString(value, ['filePath', 'file_path']);
    const fileName = readAttachmentString(value, ['fileName', 'file_name']);
    const mimeType = readAttachmentString(value, ['mimeType', 'mime_type']);
    const dataUrl = readAttachmentString(value, ['dataUrl', 'data_url', 'previewUrl', 'preview_url']);
    return {
        ...(type === 'file' || type === 'image' ? { type } : {}),
        ...(filePath ? { filePath } : {}),
        ...(fileName ? { fileName } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(dataUrl ? { dataUrl } : {}),
    };
}
function isImageAttachment(attachment) {
    const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
    return (attachment.type === 'image' ||
        mimeType.startsWith('image/') ||
        /^data:image\/[^,;]*[;,]/i.test(attachment.dataUrl ?? '') ||
        resolveNativeImageMime({ ...attachment, type: 'image' }) !== undefined);
}
function readAttachmentString(record, keys) {
    return keys
        .map((key) => record[key])
        .find((value) => typeof value === 'string' && value.length > 0);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeDataUrl(dataUrl) {
    const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
    if (!match)
        return null;
    const [rawMime = '', ...rawParams] = (match[1] ?? '').split(';');
    const body = match[2] ?? '';
    const mimeType = (rawMime || 'application/octet-stream').toLowerCase();
    const isBase64 = rawParams.some((param) => param.toLowerCase() === 'base64');
    try {
        const buffer = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body));
        return { mimeType, buffer };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=user-media.js.map