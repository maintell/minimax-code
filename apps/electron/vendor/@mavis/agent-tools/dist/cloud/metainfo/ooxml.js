// OOXML AIGC metainfo injector — docx / dotx / pptx / potx / xlsx / xltx.
//
// Wire format ports byte-for-byte from mcp-server Python
// (metainfo/injectors/document.py) and Go (~/mcp-server internal/metainfo/
// ooxml.go) implementations. All three languages MUST produce the same
// custom.xml body and word/document.xml mutation on identical inputs —
// the byte-identical golden test in test/golden/aigc-byte-identical.test.ts
// locks the contract.
//
// Wire format (matches storage-gateway internal/fs/metadata.go):
//   1. AIGC custom property is written into `docProps/custom.xml` under
//      fmtid `{D5CDD505-2E9C-101B-9397-08002B2CF9AE}` (GB 45438-2025 fixed
//      value — do NOT change).
//   2. docx / dotx ONLY get a visible AIGC footer text run inserted into
//      `word/document.xml` (GB 45438-2025 §3.1.3). Other OOXML types
//      (pptx / xlsx / potx / xltx) do NOT get the footer — storage-gateway
//      only writes it for docx, and pptx / xlsx visible labeling is out
//      of scope for this iteration.
//   3. `[Content_Types].xml` is NOT touched — Office tolerates a custom.xml
//      without an explicit Override entry; storage-gateway / Python / Go
//      all follow the same convention.
//
// JSON encoding:
//   FLAT (no AIGC wrapper). Field order = AIGCInfo struct definition
//   order (Label, ContentProducer, ProduceID, ReservedCode1,
//   ContentPropagator, PropagateID, ReservedCode2). Matches Go
//   `flatJSON(meta)` / Python `to_flat_json_bytes()`. NOT sort_keys —
//   sort_keys is only used for SM2 sign data (see sm2.ts).
//
// JSON quote escape: `"` → `&#34;` (storage-gateway L1135; the only XML
// escape needed because our 7 AIGCInfo string fields are alphanum + dash
// + space + hex sigs, never `<` `>` `&`).
//
// Idempotent: re-injecting on a doc that already has `name="AIGC"` in
// custom.xml is a no-op (returns input bytes unchanged), mirroring
// Go `hasAIGCCustomProperty` short-circuit. Defense in depth on the
// docx visible footer marker too.
import JSZip from 'jszip';
// ─────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────
/** MIME → ooxml gate. Used by inject.ts dispatcher. */
const OOXML_MIMES = new Set([
    // docx (Word)
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    // dotx (Word template)
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    // pptx (PowerPoint)
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // potx (PowerPoint template)
    'application/vnd.openxmlformats-officedocument.presentationml.template',
    // xlsx (Excel)
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // xltx (Excel template)
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
]);
/** docx / dotx ONLY get the visible footer (GB 45438-2025 §3.1.3). */
const DOCX_FOOTER_MIMES = new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
]);
/**
 * Return true when the MIME maps to an OOXML container. Pre-normalised
 * MIME expected (lowercase, no parameters); callers should pass the
 * output of `normaliseMimeType` from inject.ts.
 */
export function isOoxmlMime(mime) {
    return OOXML_MIMES.has(mime);
}
/**
 * Inject AIGCInfo into an OOXML container's `docProps/custom.xml`.
 * For docx / dotx, also appends a visible footer into `word/document.xml`.
 *
 * @param data — OOXML bytes (zip container).
 * @param mime — pre-normalised MIME string (lowercase, no parameters).
 * @param info — AIGCInfo to embed (signed by sm2.ts beforehand).
 * @returns rewritten zip bytes; throws if the input is not a valid zip
 *   container or the existing custom.xml lacks a `</Properties>` close
 *   tag (caller wraps in fail-open passthrough).
 *
 * Idempotent: if the zip already contains `name="AIGC"` inside
 * `docProps/custom.xml`, returns input bytes unchanged.
 */
export async function injectOoxml(data, mime, info) {
    if (data.length === 0)
        return data;
    if (await hasAigcCustomProperty(data))
        return data;
    const flatBytes = Buffer.from(flatJson(info), 'utf8');
    const escapedJson = xmlEscapeQuotes(flatBytes);
    const src = await JSZip.loadAsync(data);
    const dst = new JSZip();
    const injectFooter = DOCX_FOOTER_MIMES.has(mime);
    let customXmlSeen = false;
    // JSZip preserves entry order via Object.keys traversal of `files`.
    // Copy every entry; rewrite custom.xml + word/document.xml in flight.
    const entryNames = Object.keys(src.files);
    for (const name of entryNames) {
        const entry = src.files[name];
        if (!entry || entry.dir) {
            // Directory entries: pass-through with empty body (JSZip auto-creates
            // when files inside are added; but explicit dir entries from the
            // source must survive).
            if (entry?.dir)
                dst.folder(name);
            continue;
        }
        const body = await entry.async('nodebuffer');
        let outBody = body;
        if (name === CUSTOM_XML_PATH) {
            outBody = processExistingCustomXml(body, escapedJson);
            customXmlSeen = true;
        }
        else if (injectFooter && name === DOCUMENT_XML_PATH) {
            outBody = injectDocxVisibleFooter(body);
        }
        dst.file(name, outBody, {
            // Preserve per-entry compression. JSZip's read entries do not surface
            // a `compress_type` field; default to DEFLATE which matches the
            // dominant OOXML choice and what Go / Python writers also emit.
            compression: 'DEFLATE',
            date: entry.date,
            unixPermissions: entry.unixPermissions,
            dosPermissions: entry.dosPermissions,
        });
    }
    if (!customXmlSeen) {
        dst.file(CUSTOM_XML_PATH, createCustomXml(escapedJson), {
            compression: 'DEFLATE',
        });
    }
    return await dst.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
// ─────────────────────────────────────────────────────────────────
// Constants — keep aligned with Go ooxml.go + Python document.py.
// ─────────────────────────────────────────────────────────────────
const CUSTOM_XML_PATH = 'docProps/custom.xml';
const DOCUMENT_XML_PATH = 'word/document.xml';
/** GB 45438-2025 fixed fmtid value for AIGC custom property. */
const AIGC_FMTID = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';
/** Idempotency probe substring inside custom.xml. */
const AIGC_NAME_ATTR = 'name="AIGC"';
/**
 * Visible AIGC footer XML inserted into word/document.xml. Byte-for-byte
 * match with Python `_DOCX_FOOTER_XML` and Go `docxFooterXML` — centered
 * paragraph, 8pt gray run, Chinese text "由 MiniMax AI生成".
 */
const DOCX_FOOTER_XML = '<w:p><w:pPr><w:jc w:val="center"/></w:pPr>' +
    '<w:r><w:rPr><w:sz w:val="16"/><w:color w:val="808080"/></w:rPr>' +
    '<w:t>由 MiniMax AI生成</w:t></w:r></w:p>';
/** Idempotency marker — UTF-8 substring search inside document.xml. */
const DOCX_FOOTER_MARKER = '由 MiniMax AI生成';
// ─────────────────────────────────────────────────────────────────
// JSON canonicalisation (flat, no whitespace, struct-definition order).
// ─────────────────────────────────────────────────────────────────
/**
 * Flat JSON for OOXML (and PDF / video / audio) wire payloads.
 * Struct-definition order: matches Go `json.Marshal(*AIGCInfo)` /
 * Python `json.dumps(asdict(meta), separators=(",", ":"))`. Mirrors
 * audio.ts L54 (`JSON.stringify(info)` works because
 * AIGCInfo's TypeScript interface declares fields in the same order).
 *
 * No HTML escape: Node's default `JSON.stringify` already leaves `<`
 * `>` `&` unescaped. Our 7 fields are alphanum + dash + space + hex
 * sigs anyway, so escape choice is moot — but the contract is "no
 * HTML escape" for byte parity with the Python / Go reference impls.
 */
function flatJson(info) {
    // Explicit field-order copy keeps the function honest: the
    // TypeScript interface order in types.ts MUST match this layout, and
    // any future field addition needs an explicit edit here.
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
/** Escape `"` → `&#34;` so flat JSON survives XML element text. */
function xmlEscapeQuotes(buf) {
    return Buffer.from(buf.toString('utf8').replaceAll('"', '&#34;'), 'utf8');
}
// ─────────────────────────────────────────────────────────────────
// custom.xml mutation helpers.
// ─────────────────────────────────────────────────────────────────
/**
 * Build the AIGC `<property>` element for custom.xml. Matches Go
 * `buildAIGCProperty` / Python `_build_aigc_property` (storage-gateway
 * L1142 / L1160) — fmtid, pid, name attrs in this exact order.
 */
function buildAigcProperty(escapedJson, pid) {
    return (`<property fmtid="${AIGC_FMTID}" pid="${pid}" name="AIGC">` +
        `<vt:lpwstr>${escapedJson.toString('utf8')}</vt:lpwstr>` +
        '</property>');
}
/**
 * Process an existing custom.xml — replace the AIGC property if present,
 * otherwise insert a new one with `pid = max(existing) + 1`. Handles
 * both `<Properties>…</Properties>` and self-closing `<Properties .../>`
 * forms.
 *
 * Mirrors Go `processExistingCustomXML` / Python
 * `_process_existing_custom_xml` (storage-gateway L1119-1182).
 */
function processExistingCustomXml(content, escapedJson) {
    const text = content.toString('utf8');
    // Case 1: AIGC property already exists → regex replace body, pid=2.
    if (text.includes(AIGC_NAME_ATTR)) {
        const newProp = buildAigcProperty(escapedJson, 2);
        return Buffer.from(text.replace(RE_AIGC_PROPERTY, newProp), 'utf8');
    }
    // Case 2: Compute next pid = max(existing) + 1 (or 2 if none).
    let nextPid = 2;
    for (const match of text.matchAll(RE_PID_VALUE)) {
        const value = Number.parseInt(match[1] ?? '', 10);
        if (Number.isFinite(value) && value + 1 > nextPid) {
            nextPid = value + 1;
        }
    }
    const newProp = buildAigcProperty(escapedJson, nextPid);
    // Case 2a: standard `<Properties>…</Properties>` form.
    if (text.includes('</Properties>')) {
        return Buffer.from(text.replace('</Properties>', `${newProp}</Properties>`), 'utf8');
    }
    // Case 2b: self-closing `<Properties …/>` — expand to open / close pair.
    const expanded = text.replace(RE_PROPERTIES_SELF_CLOSE, `<Properties$1>${newProp}</Properties>`);
    if (expanded !== text) {
        return Buffer.from(expanded, 'utf8');
    }
    // Pathological — neither close tag nor self-closing form. Match Go +
    // Python: throw so the caller (inject.ts) can fail-open passthrough.
    throw new Error('docProps/custom.xml has no </Properties> close tag');
}
/**
 * Synthesize a new custom.xml when the OOXML container has none. Matches
 * Go `createCustomXML` / Python `_create_custom_xml` byte-for-byte.
 */
function createCustomXml(escapedJson) {
    const body = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ` +
        `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${buildAigcProperty(escapedJson, 2)}</Properties>`;
    return Buffer.from(body, 'utf8');
}
/**
 * Insert the visible AIGC footer before the last `<w:sectPr` if present,
 * otherwise before `</w:body>`. Returns content unchanged when neither
 * anchor is found (pathological) or when the marker text is already
 * present (defense-in-depth idempotency).
 *
 * Mirrors Python `_inject_docx_visible_footer` / Go
 * `injectDocxVisibleFooter`.
 */
function injectDocxVisibleFooter(content) {
    const text = content.toString('utf8');
    if (text.includes(DOCX_FOOTER_MARKER))
        return content;
    const sectIdx = text.lastIndexOf('<w:sectPr');
    if (sectIdx >= 0) {
        return Buffer.from(text.slice(0, sectIdx) + DOCX_FOOTER_XML + text.slice(sectIdx), 'utf8');
    }
    const bodyIdx = text.lastIndexOf('</w:body>');
    if (bodyIdx >= 0) {
        return Buffer.from(text.slice(0, bodyIdx) + DOCX_FOOTER_XML + text.slice(bodyIdx), 'utf8');
    }
    // No safe insertion point — return unchanged so compliance is
    // best-effort and we never risk corrupting the document.
    return content;
}
// ─────────────────────────────────────────────────────────────────
// Idempotency pre-check.
// ─────────────────────────────────────────────────────────────────
/**
 * Pre-flight: does the zip already contain `name="AIGC"` inside its
 * `docProps/custom.xml`? Mirrors Go `hasAIGCCustomProperty` /
 * Python `_has_aigc_metadata`.
 *
 * Malformed zips return false (caller's main path then surfaces the
 * "not a zip" error during the actual load).
 */
async function hasAigcCustomProperty(data) {
    try {
        const zip = await JSZip.loadAsync(data);
        const entry = zip.file(CUSTOM_XML_PATH);
        if (!entry)
            return false;
        const body = await entry.async('string');
        return body.includes(AIGC_NAME_ATTR);
    }
    catch {
        return false;
    }
}
// ─────────────────────────────────────────────────────────────────
// Regex bank — module-level compile, reused per call.
// ─────────────────────────────────────────────────────────────────
const RE_AIGC_PROPERTY = /<property[^>]*name="AIGC"[^>]*>.*?<\/property>/s;
const RE_PID_VALUE = /pid="(\d+)"/g;
const RE_PROPERTIES_SELF_CLOSE = /<Properties([^>]*)\/>/;
//# sourceMappingURL=ooxml.js.map