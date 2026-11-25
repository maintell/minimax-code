// MIME-typed AIGC metainfo injection dispatcher.
//
// Single entry point for every deliver-assets caller.
// Picks the per-format injector (image / video / audio) by MIME string
// and routes to the matching helper. Designed to be the only public
// surface of the metainfo module; per-format helpers (image.ts /
// audio.ts / video.ts) are also exported from the barrel for direct
// access in tests and specialised callers.
//
// Fail-open policy (matches storage-gateway InjectByMimeType + mcp-server
// registry.inject):
//   - Unsupported MIME (PDF, SVG, octet-stream, etc.) → return input
//     unchanged with no error.
//   - Per-format injector throws (corrupt file, ffmpeg failure) → log
//     and return input unchanged with no error. Watermarking is
//     best-effort; it must never block an upload.
//
// Nil safety:
//   - `metadata === undefined | null` → return input unchanged.
//   - `data` empty (zero-length Buffer) → return input unchanged.
//
// MIME normalisation:
//   - trim whitespace, lowercase, drop `; parameter=...` suffix
//   - matches typical HTTP Content-Type and OSS object metadata shapes
//
// This file imports from sibling modules without going through
// index.ts so internal cycles stay simple.
import { injectAudio } from './audio.js';
import { injectJpeg, injectPng } from './image.js';
import { injectOoxml, isOoxmlMime } from './ooxml.js';
import { injectPdf, isPdfMime } from './pdf.js';
import { injectVideo } from './video.js';
/**
 * Inject AIGC metadata into bytes selected by MIME type. Returns the
 * rewritten bytes, or the input bytes unchanged on fail-open / skip.
 *
 * Image MIMEs (image/jpeg, image/png) consume the nested
 * `AIGCMetadata` wrapper because their wire format embeds an `AIGC`
 * key. Video / audio MIMEs consume the flat `AIGCInfo` payload
 * because their wire format already names the field externally
 * (`ffmpeg -metadata AIGC=`, WAV RIFF subchunk ID = "AIGC", etc.).
 *
 * Callers usually have an `AIGCMetadata`; this dispatcher unwraps to
 * `AIGCInfo` for the video/audio path.
 */
export async function injectByMimeType(data, mimeType, metadata, opts = {}) {
    // nil-safety: no metadata → no-op (callers may pass undefined when
    // the watermark cache misses or the asset is non-AI-generated).
    if (!metadata)
        return data;
    // Empty buffer → no-op (avoids confusing errors from downstream parsers).
    if (!data || data.length === 0)
        return data;
    const mime = normaliseMimeType(mimeType);
    try {
        switch (mime) {
            // ── Images: nested JSON wrapper ─────────────────────────────
            case 'image/jpeg':
            case 'image/jpg':
                return injectJpeg(data, metadata);
            case 'image/png':
                return injectPng(data, metadata);
            // ── Videos: flat JSON ───────────────────────────────────────
            case 'video/mp4':
                return await injectVideo(data, '.mp4', metadata.AIGC, opts);
            case 'video/quicktime':
                return await injectVideo(data, '.mov', metadata.AIGC, opts);
            case 'video/x-matroska':
            case 'video/mkv':
                return await injectVideo(data, '.mkv', metadata.AIGC, opts);
            case 'video/webm':
                return await injectVideo(data, '.webm', metadata.AIGC, opts);
            case 'video/x-flv':
            case 'video/flv':
                return await injectVideo(data, '.flv', metadata.AIGC, opts);
            // ── Audio: flat JSON ────────────────────────────────────────
            case 'audio/wav':
            case 'audio/x-wav':
            case 'audio/wave':
                return await injectAudio(data, '.wav', metadata.AIGC, opts);
            case 'audio/mpeg':
            case 'audio/mp3':
                return await injectAudio(data, '.mp3', metadata.AIGC, opts);
            case 'audio/mp4':
            case 'audio/m4a':
            case 'audio/x-m4a':
                return await injectAudio(data, '.m4a', metadata.AIGC, opts);
            case 'audio/aac':
                return await injectAudio(data, '.aac', metadata.AIGC, opts);
            case 'audio/flac':
            case 'audio/x-flac':
                return await injectAudio(data, '.flac', metadata.AIGC, opts);
            case 'audio/ogg':
            case 'application/ogg':
                return await injectAudio(data, '.ogg', metadata.AIGC, opts);
            // ── PDF: flat JSON in Info dict /AIGC ───────────────────────
            case 'application/pdf':
                return await injectPdf(data, metadata.AIGC);
            default:
                // ── OOXML: docx / dotx / pptx / potx / xlsx / xltx ────────
                // The set of 6 MIMEs is gated by isOoxmlMime to keep the switch
                // statement readable; ooxml.ts owns the visible-footer policy
                // (only docx / dotx get the GB 45438-2025 §3.1.3 footer).
                if (isOoxmlMime(mime)) {
                    return await injectOoxml(data, mime, metadata.AIGC);
                }
                // PDF is matched by the explicit case above; keep isPdfMime
                // for callers that need to feature-detect without trying.
                if (isPdfMime(mime)) {
                    return await injectPdf(data, metadata.AIGC);
                }
                opts.logger?.('skip', { mime, reason: 'unsupported-mime' });
                return data;
        }
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        opts.logger?.('fail-open', { mime, reason });
        return data;
    }
}
/**
 * Lower-case + trim + strip parameters. Returns "" when the input is
 * null/undefined/empty after trimming. Matches storage-gateway
 * InjectByMimeType normalisation step.
 *
 * Examples:
 *   "image/PNG"                 → "image/png"
 *   "  image/jpeg; charset=x "  → "image/jpeg"
 *   undefined                   → ""
 */
export function normaliseMimeType(mimeType) {
    if (!mimeType)
        return '';
    let mt = mimeType.trim().toLowerCase();
    const semi = mt.indexOf(';');
    if (semi >= 0)
        mt = mt.slice(0, semi).trim();
    return mt;
}
//# sourceMappingURL=inject.js.map