export const IMAGE_DIMENSION_HEADER_BYTES = 96 * 1024;
const MAX_MEDIA_DIMENSION = 1_000_000;
function normalizeDimensions(width, height) {
    if (Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0 &&
        width <= MAX_MEDIA_DIMENSION &&
        height <= MAX_MEDIA_DIMENSION) {
        return { width, height };
    }
    return undefined;
}
function readAscii(bytes, offset, length) {
    if (offset < 0 || length < 0 || bytes.byteLength < offset + length)
        return undefined;
    let value = '';
    for (let index = offset; index < offset + length; index += 1) {
        value += String.fromCharCode(bytes[index]);
    }
    return value;
}
function readUint16(bytes, offset, littleEndian) {
    if (offset < 0 || bytes.byteLength < offset + 2)
        return undefined;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, littleEndian);
}
function readUint24LE(bytes, offset) {
    if (offset < 0 || bytes.byteLength < offset + 3)
        return undefined;
    return (bytes[offset] |
        (bytes[offset + 1] << 8) |
        (bytes[offset + 2] << 16));
}
function readUint32BE(bytes, offset) {
    if (offset < 0 || bytes.byteLength < offset + 4)
        return undefined;
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}
function parsePng(bytes) {
    if (bytes.byteLength < 24 ||
        readAscii(bytes, 0, 8) !== '\u0089PNG\r\n\u001a\n' ||
        readAscii(bytes, 12, 4) !== 'IHDR') {
        return undefined;
    }
    const width = readUint32BE(bytes, 16);
    const height = readUint32BE(bytes, 20);
    return width !== undefined && height !== undefined
        ? normalizeDimensions(width, height)
        : undefined;
}
function parseGif(bytes) {
    const signature = readAscii(bytes, 0, 6);
    if (signature !== 'GIF87a' && signature !== 'GIF89a')
        return undefined;
    const width = readUint16(bytes, 6, true);
    const height = readUint16(bytes, 8, true);
    return width !== undefined && height !== undefined
        ? normalizeDimensions(width, height)
        : undefined;
}
function parseWebp(bytes) {
    if (bytes.byteLength < 30 ||
        readAscii(bytes, 0, 4) !== 'RIFF' ||
        readAscii(bytes, 8, 4) !== 'WEBP') {
        return undefined;
    }
    const format = readAscii(bytes, 12, 4);
    if (format === 'VP8 ') {
        if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a)
            return undefined;
        const encodedWidth = readUint16(bytes, 26, true);
        const encodedHeight = readUint16(bytes, 28, true);
        return encodedWidth !== undefined && encodedHeight !== undefined
            ? normalizeDimensions(encodedWidth & 0x3fff, encodedHeight & 0x3fff)
            : undefined;
    }
    if (format === 'VP8L') {
        if (bytes[20] !== 0x2f)
            return undefined;
        const b0 = bytes[21];
        const b1 = bytes[22];
        const b2 = bytes[23];
        const b3 = bytes[24];
        return normalizeDimensions(1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)));
    }
    if (format === 'VP8X') {
        const encodedWidth = readUint24LE(bytes, 24);
        const encodedHeight = readUint24LE(bytes, 27);
        return encodedWidth !== undefined && encodedHeight !== undefined
            ? normalizeDimensions(1 + encodedWidth, 1 + encodedHeight)
            : undefined;
    }
    return undefined;
}
const JPEG_STANDALONE_MARKERS = new Set([
    0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9,
]);
function isJpegSofMarker(marker) {
    return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}
function parseJpeg(bytes) {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
        return undefined;
    let offset = 2;
    for (let iterations = 0; offset + 4 <= bytes.byteLength && iterations < bytes.byteLength; iterations += 1) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        const marker = bytes[offset + 1];
        if (marker === 0xff) {
            offset += 1;
            continue;
        }
        if (JPEG_STANDALONE_MARKERS.has(marker)) {
            offset += 2;
            continue;
        }
        const length = readUint16(bytes, offset + 2, false);
        if (length === undefined || length < 2)
            return undefined;
        if (isJpegSofMarker(marker)) {
            const height = readUint16(bytes, offset + 5, false);
            const width = readUint16(bytes, offset + 7, false);
            return width !== undefined && height !== undefined
                ? normalizeDimensions(width, height)
                : undefined;
        }
        offset += 2 + length;
    }
    return undefined;
}
function parseBmp(bytes) {
    if (readAscii(bytes, 0, 2) !== 'BM' || bytes.length < 26)
        return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dibSize = view.getUint32(14, true);
    if (dibSize === 12)
        return normalizeDimensions(view.getUint16(18, true), view.getUint16(20, true));
    if (dibSize < 40)
        return undefined;
    return normalizeDimensions(view.getInt32(18, true), Math.abs(view.getInt32(22, true)));
}
function parseIcon(bytes) {
    if (bytes.length < 22 || readUint16(bytes, 0, true) !== 0 || readUint16(bytes, 2, true) !== 1)
        return undefined;
    const count = readUint16(bytes, 4, true);
    if (count === 0 || count > 1024 || 6 + count * 16 > bytes.length)
        return undefined;
    let largest;
    for (let index = 0; index < count; index += 1) {
        const offset = 6 + index * 16;
        const width = bytes[offset] || 256;
        const height = bytes[offset + 1] || 256;
        if (!largest || width * height > largest.width * largest.height)
            largest = { width, height };
    }
    return largest;
}
function parseTiff(bytes) {
    const signature = readAscii(bytes, 0, 4);
    if (signature !== 'II*\u0000' && signature !== 'MM\u0000*')
        return undefined;
    if (bytes.length < 8)
        return undefined;
    const little = signature === 'II*\u0000';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = view.getUint32(4, little);
    if (offset > bytes.length - 2)
        return undefined;
    const count = view.getUint16(offset, little);
    if (count > 4096 || offset + 2 + count * 12 > bytes.length)
        return undefined;
    let width;
    let height;
    for (let index = 0; index < count; index += 1) {
        const entry = offset + 2 + index * 12;
        const tag = view.getUint16(entry, little);
        if (tag !== 256 && tag !== 257)
            continue;
        const type = view.getUint16(entry + 2, little);
        if (view.getUint32(entry + 4, little) !== 1 || (type !== 3 && type !== 4))
            return undefined;
        const value = type === 3 ? view.getUint16(entry + 8, little) : view.getUint32(entry + 8, little);
        if (tag === 256)
            width = value;
        else
            height = value;
    }
    return width !== undefined && height !== undefined
        ? normalizeDimensions(width, height)
        : undefined;
}
/** Resolve the primary HEIF/AVIF item, not a thumbnail or a grid tile's ispe. */
function parseIsoImage(bytes) {
    if (readAscii(bytes, 4, 4) !== 'ftyp')
        return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let budget = 4096;
    const boxes = (from, end) => {
        let start = from;
        const result = [];
        while (start + 8 <= end && budget-- > 0) {
            let size = view.getUint32(start);
            let header = 8;
            if (size === 1) {
                if (end - start < 16)
                    return [];
                const extended = view.getBigUint64(start + 8);
                if (extended > BigInt(Number.MAX_SAFE_INTEGER))
                    return [];
                size = Number(extended);
                header = 16;
            }
            else if (size === 0)
                size = end - start;
            if (size < header || size > end - start)
                return [];
            result.push({
                type: readAscii(bytes, start + 4, 4),
                start: start + header,
                end: start + size,
            });
            start += size;
        }
        return result;
    };
    const meta = boxes(0, bytes.length).find((box) => box.type === 'meta');
    if (!meta || meta.start + 4 > meta.end)
        return undefined;
    const children = boxes(meta.start + 4, meta.end);
    const primary = children.find((box) => box.type === 'pitm');
    const properties = children.find((box) => box.type === 'iprp');
    if (!primary || !properties || primary.end - primary.start < 6)
        return undefined;
    const version = bytes[primary.start];
    if (version !== 0 && (version !== 1 || primary.end - primary.start < 8))
        return undefined;
    const primaryId = version === 0 ? view.getUint16(primary.start + 4) : view.getUint32(primary.start + 4);
    const propertyBoxes = boxes(properties.start, properties.end);
    const container = propertyBoxes.find((box) => box.type === 'ipco');
    const associations = propertyBoxes.find((box) => box.type === 'ipma');
    if (!container || !associations || associations.end - associations.start < 8)
        return undefined;
    const values = boxes(container.start, container.end);
    const at = associations.start;
    const wideId = bytes[at] === 1;
    if (bytes[at] !== 0 && !wideId)
        return undefined;
    const wideIndex = (view.getUint32(at) & 1) !== 0;
    const count = view.getUint32(at + 4);
    if (count > 4096)
        return undefined;
    let cursor = at + 8;
    for (let index = 0; index < count; index += 1) {
        const idSize = wideId ? 4 : 2;
        if (cursor + idSize + 1 > associations.end)
            return undefined;
        const id = wideId ? view.getUint32(cursor) : view.getUint16(cursor);
        cursor += idSize;
        const propertyCount = bytes[cursor++];
        if (cursor + propertyCount * (wideIndex ? 2 : 1) > associations.end)
            return undefined;
        let result;
        let quarterTurns = 0;
        for (let p = 0; p < propertyCount; p += 1) {
            const propertyIndex = wideIndex ? view.getUint16(cursor) & 0x7fff : bytes[cursor] & 0x7f;
            cursor += wideIndex ? 2 : 1;
            if (id !== primaryId)
                continue;
            const value = values[propertyIndex - 1];
            if (value?.type === 'ispe' && value.end - value.start >= 12)
                result = normalizeDimensions(view.getUint32(value.start + 4), view.getUint32(value.start + 8));
            if (value?.type === 'irot' && value.end > value.start)
                quarterTurns = bytes[value.start] & 3;
        }
        if (id === primaryId)
            return result && quarterTurns % 2 ? { width: result.height, height: result.width } : result;
    }
    return undefined;
}
/** Parse raster dimensions without decoding pixels; truncated/unsupported headers return undefined. */
export function parseImageDimensionsFromBytes(bytes) {
    return (parsePng(bytes) ??
        parseJpeg(bytes) ??
        parseGif(bytes) ??
        parseWebp(bytes) ??
        parseBmp(bytes) ??
        parseIcon(bytes) ??
        parseTiff(bytes) ??
        parseIsoImage(bytes));
}
//# sourceMappingURL=image-dimensions.js.map