/**
 * Migration copy (MR1) of v1 `channels/inbound-media-normalizer.ts`.
 */
// The bmp-js ambient declaration must enter EVERY program that compiles this
// file — including external consumers that follow the package `types` into
// v2 source (packages/cli tsc). A colocated unreferenced .d.ts only joins the
// v2 project's own program, and an `import` of a .d.ts is not emittable, so a
// triple-slash reference is the only mechanism that carries the declaration
// along (rule exemption lives in the root .eslintrc.js override).
/// <reference path="./bmp-js.d.ts" />
import { open, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse } from 'node:path';
import { decode as decodeBmp } from 'bmp-js';
import { PNG } from 'pngjs';
import { imLogger } from '@mavis/shared/local-runtime-logging/im-logger';
import { detectMediaFromBuffer } from './media-detector.js';
const SNIFF_BYTES = 8 * 1024;
const MAX_BMP_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BMP_DIMENSION = 8_192;
const MAX_BMP_PIXELS = 16_777_216;
const RENDERABLE_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
/** Normalize downloaded IM attachments without reading non-BMP files in full. */
export async function normalizeLocalInboundAttachments(attachments) {
    const normalized = [];
    // ponytail: sequential normalization bounds concurrent decode memory; parallelize only if inbound latency proves it matters.
    for (const attachment of attachments) {
        normalized.push(await normalizeAttachment(attachment));
    }
    return normalized;
}
async function normalizeAttachment(attachment) {
    if (attachment.error || !attachment.filePath)
        return attachment;
    let handle;
    try {
        handle = await open(attachment.filePath, 'r');
        const fileSize = (await handle.stat()).size;
        const prefix = await readPrefix(handle, fileSize);
        const detected = detectMediaFromBuffer(prefix);
        if (detected?.mimeType === 'image/bmp') {
            return await convertBmp(attachment, handle, fileSize, prefix);
        }
        const media = isSvg(prefix) ? { mimeType: 'image/svg+xml', extension: 'svg' } : detected;
        if (!media || !isMultimodalMime(media.mimeType))
            return attachment;
        return applyDetectedMediaMetadata(attachment, media);
    }
    catch (error) {
        imLogger.warn({
            scope: 'channel.inbound.media',
            outcome: 'fail_open',
            reason: errorCode(error),
            originalMime: attachment.mimeType,
        }, 'Inbound attachment media normalization failed open');
        return attachment;
    }
    finally {
        await closeQuietly(handle);
    }
}
/** Best-effort close: a close failure must not mask the normalization result. */
async function closeQuietly(handle) {
    try {
        await handle?.close();
    }
    catch {
        // fd already closed / transient FS error — nothing actionable.
    }
}
/** Rewrite type/fileName/mimeType from the sniffed media; no-op rows return as-is. */
function applyDetectedMediaMetadata(attachment, media) {
    const next = {
        ...attachment,
        type: RENDERABLE_IMAGE_MIME_TYPES.has(media.mimeType) ? 'image' : 'file',
        fileName: withExtension(attachment.fileName, attachment.filePath, media.extension),
        mimeType: media.mimeType,
    };
    if (next.type === attachment.type &&
        next.fileName === attachment.fileName &&
        next.mimeType === attachment.mimeType) {
        return attachment;
    }
    imLogger.info({
        scope: 'channel.inbound.media',
        outcome: 'metadata_updated',
        detectedMime: media.mimeType,
        type: next.type,
    }, 'Inbound attachment media metadata normalized');
    return next;
}
async function readPrefix(handle, fileSize) {
    const prefix = Buffer.alloc(Math.min(SNIFF_BYTES, Math.max(0, fileSize)));
    let offset = 0;
    while (offset < prefix.length) {
        const result = await handle.read(prefix, offset, prefix.length - offset, offset);
        if (result.bytesRead === 0)
            break;
        offset += result.bytesRead;
    }
    return prefix.subarray(0, offset);
}
async function convertBmp(attachment, handle, fileSize, prefix) {
    const meta = validateBmp(prefix, fileSize);
    if (!meta.ok) {
        imLogger.warn({
            scope: 'channel.inbound.media',
            outcome: 'fail_open',
            reason: meta.reason,
            originalMime: attachment.mimeType,
            fileSize,
        }, 'Inbound BMP attachment rejected during normalization');
        return attachment;
    }
    const source = Buffer.alloc(fileSize);
    let offset = 0;
    while (offset < source.length) {
        const result = await handle.read(source, offset, source.length - offset, offset);
        if (result.bytesRead === 0)
            throw new Error('bmp_read_incomplete');
        offset += result.bytesRead;
    }
    const decoded = decodeBmp(source);
    if (decoded.width !== meta.width || Math.abs(decoded.height) !== meta.height) {
        throw new Error('bmp_dimensions_changed');
    }
    const rgba = Buffer.alloc(meta.pixels * 4);
    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = decoded.data[i + 3];
        rgba[i + 1] = decoded.data[i + 2];
        rgba[i + 2] = decoded.data[i + 1];
        rgba[i + 3] = 0xff;
    }
    // PNG.sync.write only reads width/height/data; construct a real PNG to
    // keep the types honest instead of casting a bare literal.
    const png = new PNG({ width: meta.width, height: meta.height });
    rgba.copy(png.data);
    const pngBytes = PNG.sync.write(png);
    const outputPath = await writePngSibling(attachment.filePath, pngBytes);
    const next = {
        ...attachment,
        type: 'image',
        filePath: outputPath,
        fileName: withExtension(attachment.fileName, attachment.filePath, 'png'),
        mimeType: 'image/png',
    };
    imLogger.info({
        scope: 'channel.inbound.media',
        outcome: 'bmp_to_png',
        width: meta.width,
        height: meta.height,
        inputBytes: fileSize,
        outputBytes: pngBytes.length,
    }, 'Inbound BMP attachment converted to PNG');
    return next;
}
async function writePngSibling(filePath, pngBytes) {
    const parsed = parse(filePath);
    const stem = parsed.name || 'attachment';
    for (let suffix = 0; suffix < 100; suffix += 1) {
        const outputPath = join(dirname(filePath), `${stem}${suffix ? `-${suffix}` : ''}.png`);
        try {
            await writeFile(outputPath, pngBytes, { flag: 'wx' });
            return outputPath;
        }
        catch (error) {
            if (errorCode(error) !== 'EEXIST')
                throw error;
        }
    }
    throw new Error('bmp_png_sibling_collision');
}
function validateBmp(header, fileSize) {
    if (fileSize > MAX_BMP_FILE_BYTES)
        return { ok: false, reason: 'bmp_file_too_large' };
    if (fileSize < 54 || header.length < 54)
        return { ok: false, reason: 'bmp_header_truncated' };
    const fields = readBmpHeaderFields(header);
    const headerIssue = bmpHeaderIssue(fields);
    if (headerIssue)
        return { ok: false, reason: headerIssue };
    const { width, height, bitPP } = fields;
    const pixels = width * height;
    if (pixels > MAX_BMP_PIXELS)
        return { ok: false, reason: 'bmp_pixel_count_too_large' };
    const layoutIssue = bmpLayoutIssue(fields, header.length, fileSize, pixels);
    if (layoutIssue)
        return { ok: false, reason: layoutIssue };
    return { ok: true, width, height, pixels, bitPP };
}
/** 15bpp+ formats carry no palette; low-bpp colors=0 means "full capacity". */
function readBmpPalette(fields) {
    if (fields.bitPP >= 15)
        return { capacity: 0, entries: 0 };
    const capacity = 1 << fields.bitPP;
    return { capacity, entries: fields.colors === 0 ? capacity : fields.colors };
}
function readBmpHeaderFields(header) {
    return {
        declaredFileSize: header.readUInt32LE(2),
        pixelOffset: header.readUInt32LE(10),
        dibSize: header.readUInt32LE(14),
        width: header.readUInt32LE(18),
        height: Math.abs(header.readInt32LE(22)),
        planes: header.readUInt16LE(26),
        bitPP: header.readUInt16LE(28),
        compression: header.readUInt32LE(30),
        colors: header.readUInt32LE(46),
    };
}
/** BITMAPINFOHEADER-only, uncompressed, sane dimensions. */
function bmpHeaderIssue(fields) {
    const { dibSize, compression, planes, bitPP } = fields;
    if (dibSize !== 40 ||
        compression !== 0 ||
        planes !== 1 ||
        ![1, 4, 8, 16, 24, 32].includes(bitPP)) {
        return 'bmp_header_unsupported';
    }
    return bmpDimensionsSafe(fields.width, fields.height) ? undefined : 'bmp_dimensions_unsafe';
}
function bmpDimensionsSafe(width, height) {
    return (Number.isSafeInteger(width) &&
        Number.isSafeInteger(height) &&
        width >= 1 &&
        height >= 1 &&
        width <= MAX_BMP_DIMENSION &&
        height <= MAX_BMP_DIMENSION);
}
/** Palette, pixel-offset and byte-extent consistency against the real file. */
function bmpLayoutIssue(fields, headerLength, fileSize, pixels) {
    const { bitPP, pixelOffset, declaredFileSize, width, height } = fields;
    void pixels;
    const palette = readBmpPalette(fields);
    if (palette.entries > palette.capacity)
        return 'bmp_palette_unsupported';
    const paletteEntries = palette.entries;
    const expectedPixelOffset = 54 + paletteEntries * 4;
    if (pixelOffset !== expectedPixelOffset || pixelOffset >= fileSize) {
        return 'bmp_pixel_offset_invalid';
    }
    if (headerLength < expectedPixelOffset)
        return 'bmp_palette_truncated';
    if (declaredFileSize > fileSize || (declaredFileSize > 0 && declaredFileSize < pixelOffset)) {
        return 'bmp_file_size_invalid';
    }
    const rowBytes = Math.ceil((width * bitPP) / 32) * 4;
    const pixelDataEnd = pixelOffset + rowBytes * height;
    if (pixelDataEnd > fileSize)
        return 'bmp_pixel_data_truncated';
    return undefined;
}
function isMultimodalMime(mimeType) {
    return (mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/'));
}
function isSvg(buffer) {
    if (buffer.length === 0)
        return false;
    const text = buffer
        .toString('utf8')
        .replace(/^\uFEFF/u, '')
        .trimStart();
    return /^(?:<\?xml[\s\S]*?\?>\s*)?<svg(?:\s|>|\/)/iu.test(text);
}
function withExtension(fileName, filePath, extension) {
    const input = basename(fileName || basename(filePath) || 'attachment');
    const parsed = parse(input);
    return `${parsed.name || 'attachment'}.${extension}`;
}
function errorCode(error) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return error instanceof Error ? error.name : 'normalization_failed';
}
//# sourceMappingURL=inbound-media-normalizer.js.map