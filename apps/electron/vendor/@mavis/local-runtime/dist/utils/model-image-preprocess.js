import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
export const MODEL_IMAGE_MAX_EDGE_PX = 1920;
export const MODEL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const JPEG_QUALITIES = [82, 72, 62, 52];
const MIN_IMAGE_EDGE_PX = 512;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);
export function isSupportedModelImagePath(filePath) {
    return SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
export function decodeDataUrl(dataUrl) {
    const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/s.exec(dataUrl);
    if (!match)
        return null;
    try {
        return {
            mimeType: (match[1] || 'application/octet-stream').toLowerCase(),
            buffer: Buffer.from(match[2], 'base64'),
        };
    }
    catch {
        return null;
    }
}
function isJpegMimeType(mimeType) {
    const normalized = mimeType.toLowerCase();
    return normalized === 'image/jpeg' || normalized === 'image/jpg';
}
function isJpegBuffer(buffer) {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}
function detectImageKind(buffer, filePath) {
    if (isJpegBuffer(buffer)) {
        return 'jpeg';
    }
    if (buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47) {
        return 'png';
    }
    if (!filePath)
        return null;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg')
        return 'jpeg';
    if (ext === '.png')
        return 'png';
    return null;
}
function decodeImage(buffer, filePath) {
    const kind = detectImageKind(buffer, filePath);
    if (kind === 'jpeg') {
        const decoded = jpeg.decode(buffer, { useTArray: true });
        return {
            width: decoded.width,
            height: decoded.height,
            data: decoded.data,
        };
    }
    if (kind === 'png') {
        const decoded = PNG.sync.read(buffer);
        return {
            width: decoded.width,
            height: decoded.height,
            data: decoded.data,
        };
    }
    return null;
}
function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
function targetSize(width, height, maxEdgePx) {
    const longEdge = Math.max(width, height);
    if (longEdge <= maxEdgePx)
        return { width, height };
    const scale = maxEdgePx / longEdge;
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    };
}
function resizeAndFlattenToWhite(source, width, height) {
    const out = Buffer.alloc(width * height * 4);
    const xScale = source.width / width;
    const yScale = source.height / height;
    for (let y = 0; y < height; y++) {
        const sy = (y + 0.5) * yScale - 0.5;
        const y0 = clamp(Math.floor(sy), 0, source.height - 1);
        const y1 = clamp(y0 + 1, 0, source.height - 1);
        const wy = sy - Math.floor(sy);
        for (let x = 0; x < width; x++) {
            const sx = (x + 0.5) * xScale - 0.5;
            const x0 = clamp(Math.floor(sx), 0, source.width - 1);
            const x1 = clamp(x0 + 1, 0, source.width - 1);
            const wx = sx - Math.floor(sx);
            const c00 = (y0 * source.width + x0) * 4;
            const c10 = (y0 * source.width + x1) * 4;
            const c01 = (y1 * source.width + x0) * 4;
            const c11 = (y1 * source.width + x1) * 4;
            const outIdx = (y * width + x) * 4;
            const w00 = (1 - wx) * (1 - wy);
            const w10 = wx * (1 - wy);
            const w01 = (1 - wx) * wy;
            const w11 = wx * wy;
            const r = source.data[c00] * w00 +
                source.data[c10] * w10 +
                source.data[c01] * w01 +
                source.data[c11] * w11;
            const g = source.data[c00 + 1] * w00 +
                source.data[c10 + 1] * w10 +
                source.data[c01 + 1] * w01 +
                source.data[c11 + 1] * w11;
            const b = source.data[c00 + 2] * w00 +
                source.data[c10 + 2] * w10 +
                source.data[c01 + 2] * w01 +
                source.data[c11 + 2] * w11;
            const a = source.data[c00 + 3] * w00 +
                source.data[c10 + 3] * w10 +
                source.data[c01 + 3] * w01 +
                source.data[c11 + 3] * w11;
            out[outIdx] = Math.round((r * a + 255 * (255 - a)) / 255);
            out[outIdx + 1] = Math.round((g * a + 255 * (255 - a)) / 255);
            out[outIdx + 2] = Math.round((b * a + 255 * (255 - a)) / 255);
            out[outIdx + 3] = 255;
        }
    }
    return { width, height, data: out };
}
function encodeJpeg(image, quality) {
    return jpeg.encode({ data: image.data, width: image.width, height: image.height }, quality).data;
}
function encodeJpegWithinLimit(image, maxBytes) {
    let current = image;
    let smallest = null;
    while (true) {
        for (const quality of JPEG_QUALITIES) {
            const encoded = encodeJpeg(current, quality);
            if (!smallest || encoded.length < smallest.length)
                smallest = encoded;
            if (encoded.length <= maxBytes)
                return encoded;
        }
        const longEdge = Math.max(current.width, current.height);
        if (!smallest || longEdge <= MIN_IMAGE_EDGE_PX) {
            return smallest && smallest.length <= maxBytes ? smallest : null;
        }
        const ratio = Math.max(0.5, Math.sqrt(maxBytes / smallest.length) * 0.95);
        current = resizeAndFlattenToWhite(current, Math.max(1, Math.round(current.width * ratio)), Math.max(1, Math.round(current.height * ratio)));
    }
}
function resolveMaxBytes(options) {
    const maxBytes = Math.floor(options?.maxBytes ?? MODEL_IMAGE_MAX_BYTES);
    return maxBytes > 0 ? maxBytes : MODEL_IMAGE_MAX_BYTES;
}
function resolveMaxEdgePx(options) {
    const maxEdgePx = Math.floor(options?.maxEdgePx ?? MODEL_IMAGE_MAX_EDGE_PX);
    return maxEdgePx > 0 ? maxEdgePx : MODEL_IMAGE_MAX_EDGE_PX;
}
export function buildPassthroughModelJpegFilePart(decoded, fileName, dataUrl, options) {
    if (!isJpegMimeType(decoded.mimeType))
        return null;
    if (decoded.buffer.length > resolveMaxBytes(options))
        return null;
    if (!isJpegBuffer(decoded.buffer))
        return null;
    return {
        type: 'file',
        mime: 'image/jpeg',
        filename: fileName,
        url: dataUrl,
    };
}
export function buildCompressedModelImageFromBuffer(buffer, fileName, sourcePath, options) {
    const decoded = decodeImage(buffer, sourcePath ?? fileName);
    if (!decoded)
        return null;
    const size = targetSize(decoded.width, decoded.height, resolveMaxEdgePx(options));
    const flattened = resizeAndFlattenToWhite(decoded, size.width, size.height);
    const jpegBuffer = encodeJpegWithinLimit(flattened, resolveMaxBytes(options));
    if (!jpegBuffer)
        return null;
    return {
        filePart: {
            type: 'file',
            mime: 'image/jpeg',
            filename: fileName,
            url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`,
        },
        sizeBytes: jpegBuffer.length,
        width: flattened.width,
        height: flattened.height,
    };
}
export async function buildCompressedModelImageFromFile(filePath, fileName = path.basename(filePath) || 'image.jpg', options) {
    const buffer = await readFile(filePath);
    return buildCompressedModelImageFromBuffer(buffer, fileName, filePath, options);
}
//# sourceMappingURL=model-image-preprocess.js.map