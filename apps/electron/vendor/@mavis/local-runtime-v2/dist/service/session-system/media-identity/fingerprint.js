import { createHash } from 'node:crypto';
import { IMAGE_DIMENSION_HEADER_BYTES, parseImageDimensionsFromBytes, } from '@mavis/shared/image-dimensions';
/**
 * Streams SHA256 over every byte while keeping only the header needed for dimensions
 * and at most one bounded metadata block for the AIGC label.
 */
export function createFingerprinter() {
    const hash = createHash('sha256');
    const label = createAigcLabelReader();
    const header = [];
    let headerBytes = 0;
    return {
        update(chunk) {
            hash.update(chunk);
            label.update(chunk);
            if (headerBytes >= IMAGE_DIMENSION_HEADER_BYTES)
                return;
            const part = chunk.subarray(0, IMAGE_DIMENSION_HEADER_BYTES - headerBytes);
            header.push(part);
            headerBytes += part.byteLength;
        },
        finish() {
            const dimensions = parseImageDimensionsFromBytes(Buffer.concat(header));
            const aigc = label.finish();
            return {
                sha256: hash.digest('hex'),
                ...(dimensions ? { dimensions } : {}),
                ...(aigc ? { aigc } : {}),
            };
        },
    };
}
export function sameDimensions(left, right) {
    return Boolean(left && right && left.width === right.width && left.height === right.height);
}
/** Both images carry the generator's AIGC label and, when both record a ProduceID, the same one. */
export function sameAigcOrigin(left, right) {
    if (!left || !right)
        return false;
    return !left.produceId || !right.produceId || left.produceId === right.produceId;
}
const MAX_LABEL_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const USER_COMMENT_ASCII = Buffer.from('ASCII\0\0\0', 'latin1');
const EXIF_IFD_POINTER = 0x8769;
const USER_COMMENT = 0x9286;
const EMPTY = Buffer.alloc(0);
function createAigcLabelReader() {
    const scan = scanAigcLabel();
    let need;
    let label;
    let parts = [];
    let partBytes = 0;
    const advance = (input) => {
        let step = scan.next(input);
        while (!step.done && ('skip' in step.value ? step.value.skip : step.value.read) === 0)
            step = scan.next(EMPTY);
        need = step.done ? undefined : step.value;
        if (step.done)
            label = step.value;
    };
    advance(EMPTY);
    return {
        update(chunk) {
            let offset = 0;
            while (need && offset < chunk.byteLength) {
                if ('skip' in need) {
                    const take = Math.min(need.skip, chunk.byteLength - offset);
                    offset += take;
                    if (take < need.skip)
                        need = { skip: need.skip - take };
                    else
                        advance(EMPTY);
                    continue;
                }
                const take = Math.min(need.read - partBytes, chunk.byteLength - offset);
                parts.push(Buffer.from(chunk.subarray(offset, offset + take)));
                partBytes += take;
                offset += take;
                if (partBytes < need.read)
                    continue;
                const data = Buffer.concat(parts);
                parts = [];
                partBytes = 0;
                advance(data);
            }
        },
        // A truncated stream never yields a label.
        finish: () => (need ? undefined : label),
    };
}
function* scanAigcLabel() {
    const head = yield { read: 2 };
    if (head[0] === 0xff && head[1] === 0xd8)
        return yield* scanJpeg();
    if (head[0] !== PNG_SIGNATURE[0] || head[1] !== PNG_SIGNATURE[1])
        return undefined;
    const rest = yield { read: PNG_SIGNATURE.length - 2 };
    return Buffer.concat([head, rest]).equals(PNG_SIGNATURE) ? yield* scanPng() : undefined;
}
/** The PNG label is a `tEXt` chunk keyed `AIGC`, written after the pixel data before IEND. */
function* scanPng() {
    for (;;) {
        const header = yield { read: 8 };
        const length = header.readUInt32BE(0);
        const type = header.toString('latin1', 4, 8);
        if (type === 'IEND' || length > 0x7fffffff)
            return undefined;
        if (type !== 'tEXt' || length > MAX_LABEL_BYTES) {
            yield { skip: length + 4 };
            continue;
        }
        const data = yield { read: length };
        const separator = data.indexOf(0);
        if (separator > 0 && data.toString('latin1', 0, separator) === 'AIGC')
            return parseAigcLabel(data.toString('latin1', separator + 1));
        yield { skip: 4 };
    }
}
/** The JPEG label is the EXIF UserComment of an APP1 segment, which precedes the scan data. */
function* scanJpeg() {
    for (;;) {
        const marker = yield* nextJpegMarker();
        if (marker === undefined || marker === 0xda || marker === 0xd9)
            return undefined;
        if (isStandaloneJpegMarker(marker))
            continue;
        const length = (yield { read: 2 }).readUInt16BE(0) - 2;
        if (length < 0)
            return undefined;
        if (marker !== 0xe1) {
            yield { skip: length };
            continue;
        }
        const label = exifUserCommentLabel(yield { read: length });
        if (label)
            return label;
    }
}
/** Reads one marker code past any 0xFF fill bytes; undefined when no marker follows. */
function* nextJpegMarker() {
    if ((yield { read: 1 }).readUInt8(0) !== 0xff)
        return undefined;
    let marker = 0xff;
    while (marker === 0xff)
        marker = (yield { read: 1 }).readUInt8(0);
    return marker;
}
function isStandaloneJpegMarker(marker) {
    return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}
function readTiff(tiff, at, size) {
    if (at === undefined || at < 0 || at + size > tiff.bytes.length)
        return undefined;
    const { bytes, little } = tiff;
    if (size === 2)
        return little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
    return little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
}
/** Offset of the 12-byte entry for `tag` in the IFD at `offset`. */
function findIfdEntry(tiff, offset, tag) {
    const count = readTiff(tiff, offset, 2);
    if (offset === undefined || count === undefined)
        return undefined;
    for (let index = 0; index < count; index += 1) {
        const entry = offset + 2 + index * 12;
        const entryTag = readTiff(tiff, entry, 2);
        if (entryTag === undefined)
            return undefined;
        if (entryTag === tag)
            return entry;
    }
    return undefined;
}
function exifUserCommentLabel(segment) {
    const tiff = exifTiff(segment);
    const value = tiff && userComment(tiff);
    if (!value?.subarray(0, USER_COMMENT_ASCII.length).equals(USER_COMMENT_ASCII))
        return undefined;
    return parseAigcLabel(value.toString('utf8', USER_COMMENT_ASCII.length));
}
function exifTiff(segment) {
    if (segment.toString('latin1', 0, 6) !== 'Exif\0\0')
        return undefined;
    const bytes = segment.subarray(6);
    const order = bytes.toString('latin1', 0, 2);
    return order === 'II' || order === 'MM' ? { bytes, little: order === 'II' } : undefined;
}
/** The UserComment value, stored in IFD0 by the generator or in the Exif IFD by EXIF writers. */
function userComment(tiff) {
    const ifd0 = readTiff(tiff, 4, 4);
    const pointer = findIfdEntry(tiff, ifd0, EXIF_IFD_POINTER);
    const exifIfd = pointer === undefined ? undefined : readTiff(tiff, pointer + 8, 4);
    const entry = findIfdEntry(tiff, ifd0, USER_COMMENT) ?? findIfdEntry(tiff, exifIfd, USER_COMMENT);
    const length = entry === undefined ? undefined : readTiff(tiff, entry + 4, 4);
    if (entry === undefined || length === undefined)
        return undefined;
    // Values longer than four bytes are stored at the entry's offset.
    const start = length > 4 ? readTiff(tiff, entry + 8, 4) : entry + 8;
    if (start === undefined || start + length > tiff.bytes.length)
        return undefined;
    return tiff.bytes.subarray(start, start + length);
}
/** The generator writes nested JSON: `{"AIGC":{"ProduceID":"…",…}}`. */
function parseAigcLabel(text) {
    let parsed;
    try {
        parsed = JSON.parse(text.replace(/\0+$/u, ''));
    }
    catch {
        return undefined;
    }
    const label = record(parsed)?.AIGC;
    if (!record(label))
        return undefined;
    const produceId = record(label)?.ProduceID;
    return { produceId: typeof produceId === 'string' ? produceId : '' };
}
function record(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=fingerprint.js.map