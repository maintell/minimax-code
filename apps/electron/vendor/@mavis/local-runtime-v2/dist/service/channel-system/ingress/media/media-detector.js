/**
 * Migration copy (MR1) of v1 `channels/media-detector.ts`.
 *
 * Rewritten table-driven for the v2 complexity budget: every v1 signature is
 * one entry below, in the exact v1 evaluation order (images → audio →
 * ISO-BMFF → webm → documents). Matching semantics are unchanged.
 */
/** Whether the buffer starts with one complete, structurally valid FileTypeBox. */
export function hasValidIsoBmffFileTypeBox(buffer) {
    return readIsoBmffBrands(buffer) !== undefined;
}
const ascii = (text) => [...text].map((ch) => ch.charCodeAt(0));
/**
 * v1 signature order, images then audio. GIF87a/GIF89a are two rows because
 * the v1 check accepted either version byte.
 */
const MEDIA_SIGNATURES = [
    {
        minLength: 3,
        segments: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
        media: { mimeType: 'image/jpeg', extension: 'jpg' },
    },
    {
        minLength: 8,
        segments: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }],
        media: { mimeType: 'image/png', extension: 'png' },
    },
    {
        minLength: 6,
        segments: [{ offset: 0, bytes: ascii('GIF89a') }],
        media: { mimeType: 'image/gif', extension: 'gif' },
    },
    {
        minLength: 6,
        segments: [{ offset: 0, bytes: ascii('GIF87a') }],
        media: { mimeType: 'image/gif', extension: 'gif' },
    },
    {
        minLength: 12,
        segments: [
            { offset: 0, bytes: ascii('RIFF') },
            { offset: 8, bytes: ascii('WEBP') },
        ],
        media: { mimeType: 'image/webp', extension: 'webp' },
    },
    {
        minLength: 2,
        segments: [{ offset: 0, bytes: ascii('BM') }],
        media: { mimeType: 'image/bmp', extension: 'bmp' },
    },
    {
        minLength: 4,
        segments: [{ offset: 0, bytes: ascii('OggS') }],
        media: { mimeType: 'audio/ogg', extension: 'ogg' },
    },
    {
        minLength: 4,
        segments: [{ offset: 0, bytes: ascii('fLaC') }],
        media: { mimeType: 'audio/flac', extension: 'flac' },
    },
    {
        minLength: 12,
        segments: [
            { offset: 0, bytes: ascii('RIFF') },
            { offset: 8, bytes: ascii('WAVE') },
        ],
        media: { mimeType: 'audio/wav', extension: 'wav' },
    },
    {
        minLength: 3,
        segments: [{ offset: 0, bytes: [0x49, 0x44, 0x33] }],
        media: { mimeType: 'audio/mpeg', extension: 'mp3' },
    },
];
/** Signatures evaluated after the ISO-BMFF branch (v1 order). */
const LATE_SIGNATURES = [
    {
        minLength: 4,
        segments: [{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
        media: { mimeType: 'video/webm', extension: 'webm' },
    },
    {
        minLength: 5,
        segments: [{ offset: 0, bytes: ascii('%PDF-') }],
        media: { mimeType: 'application/pdf', extension: 'pdf' },
    },
    {
        minLength: 4,
        segments: [{ offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] }],
        media: { mimeType: 'application/zip', extension: 'zip' },
    },
];
/** ISO-BMFF ftyp brand → media, first match wins (v1 order). */
const ISO_BMFF_BRAND_MEDIA = [
    [['avif', 'avis'], { mimeType: 'image/avif', extension: 'avif' }],
    [['heic', 'heix', 'heim', 'heis'], { mimeType: 'image/heic', extension: 'heic' }],
    [['mif1'], { mimeType: 'image/heif', extension: 'heif' }],
    [['mp41', 'mp42'], { mimeType: 'video/mp4', extension: 'mp4' }],
    [['qt  '], { mimeType: 'video/quicktime', extension: 'mov' }],
];
/**
 * Sniff common binary signatures. Callers should treat an absent result as an
 * opaque file; documents and archives must keep their platform metadata.
 */
export function detectMediaFromBuffer(buffer) {
    if (!buffer || buffer.length < 4)
        return undefined;
    const early = matchSignatures(buffer, MEDIA_SIGNATURES);
    if (early)
        return early;
    // An ftyp box with unknown brands is FINAL (opaque file), matching v1:
    // never fall through to webm/document sniffing for an ISO-BMFF container.
    const ftypBrands = readIsoBmffBrands(buffer);
    if (ftypBrands)
        return detectIsoBmff(ftypBrands);
    return matchSignatures(buffer, LATE_SIGNATURES);
}
function matchSignatures(buffer, rules) {
    for (const rule of rules) {
        if (buffer.length >= rule.minLength && rule.segments.every((s) => segmentMatches(buffer, s))) {
            return rule.media;
        }
    }
    return undefined;
}
function segmentMatches(buffer, segment) {
    return segment.bytes.every((byte, index) => buffer[segment.offset + index] === byte);
}
function detectIsoBmff(ftypBrands) {
    const brands = new Set(ftypBrands);
    for (const [candidates, media] of ISO_BMFF_BRAND_MEDIA) {
        if (candidates.some((brand) => brands.has(brand)))
            return media;
    }
    return undefined;
}
function readIsoBmffBrands(buffer) {
    if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp')
        return undefined;
    const boxSize = buffer.readUInt32BE(0);
    if (boxSize < 16 || boxSize > buffer.length || (boxSize - 16) % 4 !== 0)
        return undefined;
    const brands = [buffer.toString('ascii', 8, 12)];
    for (let offset = 16; offset < boxSize; offset += 4) {
        brands.push(buffer.toString('ascii', offset, offset + 4));
    }
    return brands;
}
//# sourceMappingURL=media-detector.js.map