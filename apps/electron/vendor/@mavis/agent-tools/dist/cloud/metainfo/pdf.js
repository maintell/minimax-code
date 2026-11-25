// PDF AIGC metainfo injector — Document Information Dictionary `/AIGC`.
//
// Wire format port from mcp-server Python (metainfo/injectors/pdf.py) and
// storage-gateway Go (internal/fs/metadata.go ProcessPDFToBytes). All
// three languages MUST produce a PDF whose Info dictionary carries a
// `/AIGC` key with the same flat-JSON UTF-8 string value — the byte-
// identical golden test locks the contract on a fixed sample PDF.
//
// Why Info dict and not XMP metadata stream:
//   storage-gateway uses pdfcpu which mutates Info dict; mcp-server
//   Python uses pikepdf and writes `pdf.docinfo['/AIGC'] = json_str`;
//   both surfaces converge on PDF 1.x Info dict. XMP would require
//   parsing the metadata stream and re-emitting — more brittle and
//   not what storage-gateway / mcp-server do today.
//
// JSON encoding: FLAT JSON in struct-definition order (Label first),
// matching ooxml.ts / audio.ts / video.ts. Mirrors Python
// `payload.to_flat_json_bytes()`.
//
// pdf-lib re-serialises the whole PDF on save (compresses streams,
// rewrites xref) — file bytes change beyond just the Info dict. That's
// unavoidable and matches Python pikepdf + Go pdfcpu behaviour; the
// byte-identical golden test pins the OUTPUT bytes for a given pdf-lib
// version so cross-language parity is the producer-side contract
// (Python / Go each pin their own version's output).
import { PDFDocument, PDFDict, PDFHexString, PDFName } from 'pdf-lib';
// ─────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────
const PDF_MIME = 'application/pdf';
/**
 * Return true when MIME is `application/pdf`. Pre-normalised MIME
 * expected (lowercase, no parameters).
 */
export function isPdfMime(mime) {
    return mime === PDF_MIME;
}
/**
 * Inject AIGCInfo into a PDF by writing flat JSON into the Document
 * Information Dictionary under key `/AIGC`. Returns the rewritten bytes.
 *
 * @param data — PDF bytes.
 * @param info — AIGCInfo to embed (sm2 signatures pre-filled).
 * @returns rewritten PDF bytes; throws if pdf-lib cannot parse the input
 *   (caller wraps in fail-open passthrough at the dispatcher layer).
 *
 * `updateMetadata: false` is passed on both load and save so pdf-lib does
 * NOT overwrite the document's Producer / ModDate with its own "pdf-lib"
 * marker — preserves the original PDF metadata aside from the new
 * `/AIGC` key.
 */
export async function injectPdf(data, info) {
    if (data.length === 0)
        return data;
    const flatJsonStr = flatJson(info);
    const pdfDoc = await PDFDocument.load(data, { updateMetadata: false });
    // Ensure the trailer has an Info dictionary; pdf-lib only autoloads
    // one when it already exists in the input. For a fresh PDF without
    // Info we register a new empty dict so `set` below has a target.
    const infoDict = ensureInfoDict(pdfDoc);
    // PDF spec: Info dictionary keys are name objects; values for custom
    // keys are typically text strings. We use PDFHexString.fromText to
    // produce a `<FEFF…>` UTF-16BE hex string with the standard BOM — the
    // safest container for Chinese / non-ASCII / JSON-special characters
    // and the same shape pdf-lib uses for its built-in Title / Producer
    // setters. PdfReaders (Adobe Acrobat, Preview, pdfcpu, pikepdf) all
    // decode this back to a Unicode string.
    infoDict.set(PDFName.of('AIGC'), PDFHexString.fromText(flatJsonStr));
    const bytes = await pdfDoc.save({ useObjectStreams: false });
    return Buffer.from(bytes);
}
// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────
/**
 * Resolve or create the Info dictionary on the PDF trailer. Mirrors
 * pdf-lib's private `getInfoDict` logic so we don't depend on the
 * library exposing it.
 */
function ensureInfoDict(pdfDoc) {
    const ctx = pdfDoc.context;
    const existingRef = ctx.trailerInfo.Info;
    if (existingRef) {
        const existing = ctx.lookup(existingRef);
        if (existing instanceof PDFDict)
            return existing;
    }
    const fresh = ctx.obj({});
    if (!(fresh instanceof PDFDict)) {
        // ctx.obj({}) returns PDFDict; guard rail for an impossible branch.
        throw new Error('pdf-lib obj({}) did not return PDFDict');
    }
    ctx.trailerInfo.Info = ctx.register(fresh);
    return fresh;
}
/**
 * Flat JSON for the PDF Info `/AIGC` payload. Struct-definition order
 * (Label first) — same canonical layout used by ooxml.ts / video / audio
 * wire payloads, ported byte-for-byte from Python `to_flat_json_bytes()`
 * and Go `flatJSON`.
 */
function flatJson(info) {
    return JSON.stringify({
        Label: info.Label,
        ContentProducer: info.ContentProducer,
        ProduceID: info.ProduceID,
        ReservedCode1: info.ReservedCode1,
        ContentPropagator: info.ContentPropagator,
        PropagateID: info.PropagateID,
        ReservedCode2: info.ReservedCode2,
    });
}
//# sourceMappingURL=pdf.js.map