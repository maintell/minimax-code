// Image AIGC injector — JPEG (EXIF UserComment 0x9286) + PNG (tEXt chunk).
//
// Wire format aligned with mcp-server (Python) injectors/image.py:
//
//   - JPEG: EXIF UserComment tag (0x9286), `ASCII\0\0\0` (8-byte
//           CharCode prefix per Exif spec) + NESTED JSON bytes
//           `{"AIGC": {...}}`. Stamped via piexifjs.insert which
//           preserves the original JPEG bytestream (no re-encoding,
//           no quality loss).
//   - PNG:  tEXt chunk keyword="AIGC", value = NESTED JSON UTF-8 text
//           `{"AIGC": {...}}`. Inserted just before the IEND chunk
//           via png-chunks-extract / png-chunks-encode.
//
// Why nested JSON for both formats (vs. flat for video/audio): matches
// mcp-server `to_nested_json_bytes()` behaviour. Reverse-lookup tools
// in mcp-server already expect the `AIGC` wrapper key when reading
// from these formats; this package stays compatible by emitting the
// same shape.
//
// Idempotency: re-injecting the same metadata over an already-marked
// asset is supported — the existing AIGC tEXt chunk is dropped before
// the new one is added (PNG), and the EXIF UserComment is overwritten
// (JPEG).
import piexif from 'piexifjs';
// png-chunks-* / png-chunk-text are pure-JS, no native deps.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pngExtract from 'png-chunks-extract';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pngEncode from 'png-chunks-encode';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import pngText from 'png-chunk-text';
/**
 * Inject AIGC metadata into JPEG bytes via EXIF UserComment (0x9286).
 *
 * Algorithm (mcp-server _inject_jpeg parity):
 *   1. JSON-stringify the AIGCMetadata wrapper → UTF-8 bytes.
 *   2. Prepend 8-byte `ASCII\0\0\0` Exif UserComment CharCode prefix.
 *   3. Load existing EXIF (or seed empty) via piexifjs.load.
 *   4. Overwrite Exif IFD tag 0x9286 with the new bytes.
 *   5. piexifjs.dump → new EXIF blob.
 *   6. piexifjs.insert → new JPEG (no recompression).
 *
 * Returns the rewritten JPEG bytes.
 */
export function injectJpeg(data, metadata) {
    // piexifjs uses "binary strings" (each byte is a single char codepoint
    // 0–255) for JPEG I/O — the same trick the JS port inherited from the
    // Python `bytes` API.
    const jpegBinary = data.toString('binary');
    // Load existing EXIF or fall back to empty IFDs.
    let exifDict;
    try {
        exifDict = piexif.load(jpegBinary);
    }
    catch {
        exifDict = { '0th': {}, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: undefined };
    }
    if (!exifDict.Exif)
        exifDict.Exif = {};
    // Build UserComment value: 8-byte ASCII\0\0\0 charcode prefix + nested
    // JSON UTF-8 bytes (matches storage-gateway + mcp-server wire format).
    const nestedJsonBytes = Buffer.from(JSON.stringify(metadata), 'utf8');
    const userCommentBuf = Buffer.concat([Buffer.from('ASCII\0\0\0', 'binary'), nestedJsonBytes]);
    exifDict.Exif[piexif.ExifIFD.UserComment] = userCommentBuf.toString('binary');
    // piexifjs.dump returns binary string; .insert returns updated JPEG.
    const exifBytes = piexif.dump(exifDict);
    const updatedBinary = piexif.insert(exifBytes, jpegBinary);
    return Buffer.from(updatedBinary, 'binary');
}
/**
 * Inject AIGC metadata into PNG bytes via tEXt chunk keyword="AIGC".
 *
 * Algorithm (mcp-server _inject_png parity, but using png-chunks-extract
 * for explicit IEND-before insertion since png-chunks-encode emits
 * chunks in order):
 *   1. Extract existing chunks via png-chunks-extract.
 *   2. Drop any existing tEXt chunk with keyword "AIGC" (idempotent
 *      re-injection).
 *   3. Build new tEXt chunk: png-chunk-text.encode("AIGC", JSON).
 *   4. Insert just before IEND (last chunk).
 *   5. png-chunks-encode → new PNG bytes.
 *
 * Returns the rewritten PNG bytes.
 */
export function injectPng(data, metadata) {
    const chunks = pngExtract(new Uint8Array(data));
    const filtered = chunks.filter((c) => !(c.name === 'tEXt' && readPngTextKeyword(c) === 'AIGC'));
    const nestedJson = JSON.stringify(metadata);
    const aigcChunk = pngText.encode('AIGC', nestedJson);
    // PNG spec: tEXt must appear before IEND. The last chunk is always
    // IEND in well-formed PNGs; insert at second-to-last so IEND stays
    // last. If for some reason IEND isn't last, splice at the IEND index.
    const iendIdx = filtered.findIndex((c) => c.name === 'IEND');
    if (iendIdx >= 0) {
        filtered.splice(iendIdx, 0, aigcChunk);
    }
    else {
        filtered.push(aigcChunk);
    }
    const out = pngEncode(filtered);
    return Buffer.from(out);
}
/**
 * Decode a tEXt chunk's keyword (bytes up to the first NUL). Returns
 * "" on malformed chunks rather than throwing — callers use this only
 * for filtering, where missing keyword → keep the chunk.
 */
function readPngTextKeyword(chunk) {
    const data = chunk.data;
    const nul = data.indexOf(0);
    if (nul < 0)
        return '';
    return Buffer.from(data.slice(0, nul)).toString('latin1');
}
//# sourceMappingURL=image.js.map