// Audio AIGC injector — WAV inline RIFF + MP3 ID3v2 + ffmpeg for
// M4A/AAC/FLAC/OGG.
//
// Wire format aligned with mcp-server (Python) injectors/audio.py and
// storage-gateway Go audio path. All audio formats use FLAT JSON
// (no `{"AIGC": {...}}` wrapper).
//
// Per-format routing:
//   - .wav, .x-wav, .wave  → inline RIFF AIGC subchunk (no ffmpeg).
//                            Byte-identical port of storage-gateway
//                            addAIGCToWAV + mcp-server _add_aigc_to_wav.
//   - .mp3                 → ID3v2.3 TXXX:AIGC via node-id3 (pure JS,
//                            no ffmpeg). Mirrors mcp-server _inject_mp3
//                            wire-shape: ID3v2.3, encoding=UTF-8 (3),
//                            description="AIGC".
//   - .m4a, .aac, .flac,   → ffmpeg subprocess with `-metadata AIGC=<json>`
//     .ogg, .oga              -codec copy, per-format flag set matching
//                              storage-gateway audio.go.
//
// MIME→ext normalisation lives in inject.ts; this module receives the
// already-resolved extension. ffmpeg subprocess is fail-loud — caller
// (inject.ts) wraps in try/catch to apply fail-open passthrough.
import nodeId3 from 'node-id3';
import { ffmpegInputArgs, reserveTempFile, runFfmpeg, writeTempFile, FFMPEG_TIMEOUT_MS, } from './ffmpeg.js';
/** Audio extensions supported by this module (lowercase, with leading dot). */
const SUPPORTED_AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.oga']);
/**
 * Inject AIGCInfo into audio bytes by extension. Returns the rewritten
 * bytes. Throws on unsupported extension or ffmpeg failure — caller is
 * responsible for fail-open passthrough on error.
 *
 * @param data — input audio bytes.
 * @param ext — lowercase extension with leading dot (e.g. ".wav").
 * @param info — flat AIGCInfo (caller has already filled signatures
 *   via sm2.fillSignatures if applicable).
 * @param opts.signal — propagate AbortSignal to ffmpeg subprocess.
 * @param opts.timeoutMs — override default ffmpeg timeout.
 */
export async function injectAudio(data, ext, info, opts = {}) {
    const normalisedExt = ext.toLowerCase();
    if (!SUPPORTED_AUDIO_EXT.has(normalisedExt)) {
        throw new Error(`unsupported audio extension: ${ext}`);
    }
    const flatJson = JSON.stringify(info);
    if (normalisedExt === '.wav') {
        return addAigcToWav(data, Buffer.from(flatJson, 'utf8'));
    }
    if (normalisedExt === '.mp3') {
        return injectMp3(data, flatJson);
    }
    return injectViaFfmpeg(data, normalisedExt, flatJson, opts);
}
/**
 * MP3 ID3v2.3 TXXX:AIGC = flat JSON via node-id3. Pure JS, no
 * subprocess. Mirrors mcp-server _inject_mp3 (mutagen-based) wire shape.
 *
 * node-id3's `update` preserves existing tags and replaces only the
 * userDefinedText entry whose description matches "AIGC".
 */
function injectMp3(data, flatJson) {
    const updated = nodeId3.update({
        userDefinedText: [{ description: 'AIGC', value: flatJson }],
    }, data);
    if (!Buffer.isBuffer(updated)) {
        throw new Error('node-id3.update did not return a buffer');
    }
    return updated;
}
/**
 * ffmpeg subprocess injection for M4A / AAC / FLAC / OGG.
 *
 * Per-format flag set is byte-identical to storage-gateway audio.go
 * buildFFmpegAudioMetadataCmd (matches mcp-server when mutagen falls
 * back to ffmpeg):
 *
 *   .m4a, .aac     → -movflags use_metadata_tags  -codec copy
 *   .flac          → -codec copy
 *   .ogg, .oga     → -codec copy
 *
 * `-codec copy` skips re-encoding, so audio samples pass through
 * untouched (signatures over the input bytes remain meaningful for
 * downstream verification).
 */
async function injectViaFfmpeg(data, ext, flatJson, opts) {
    const inFile = await writeTempFile(`mavis-metainfo-audio-in-*${ext}`, data);
    const outFile = await reserveTempFile(`mavis-metainfo-audio-out-*${ext}`);
    try {
        const args = [
            ...ffmpegInputArgs(inFile.path),
            '-metadata',
            `AIGC=${flatJson}`,
            '-codec',
            'copy',
        ];
        if (ext === '.m4a' || ext === '.aac') {
            args.push('-movflags', 'use_metadata_tags');
        }
        args.push('-y', outFile.path);
        await runFfmpeg(args, {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs ?? FFMPEG_TIMEOUT_MS,
        });
        const { promises: fs } = await import('node:fs');
        return await fs.readFile(outFile.path);
    }
    finally {
        await inFile.cleanup();
        await outFile.cleanup();
    }
}
// ─────────────────────────────────────────────────────────────────
// WAV inline RIFF AIGC subchunk
// ─────────────────────────────────────────────────────────────────
/**
 * Insert a RIFF Subchunk with ID="AIGC" carrying `metadataJson` as
 * payload. Byte-identical port of mcp-server `_add_aigc_to_wav` +
 * storage-gateway `addAIGCToWAV` (L2050-2116).
 *
 * RIFF chunk layout:
 *   offset 0..4:    'RIFF'
 *   offset 4..8:    total_size  (uint32 LE, excludes 8-byte RIFF+size header)
 *   offset 8..12:   'WAVE'
 *   offset 12..:    fmt / data / ... subchunks
 *
 * AIGC subchunk written:
 *   'AIGC' (4) + uint32_le(payload_size) + payload + optional 0-byte pad
 *                                                   (when payload_size is odd)
 *
 * Idempotent: if `wavData` already contains an AIGC subchunk, returns
 * the input unchanged.
 *
 * Insert position: immediately before the "data" chunk header (so
 * sample bytes stay at the same byte offset for downstream tools that
 * cache offsets), or end-of-file when no data chunk is found.
 *
 * Throws on malformed RIFF/WAVE header (< 12 bytes, missing "RIFF" or
 * "WAVE" markers).
 */
export function addAigcToWav(wavData, metadataJson) {
    if (wavData.length < 12)
        throw new Error('WAV file too small (<12 bytes)');
    if (wavData.toString('ascii', 0, 4) !== 'RIFF')
        throw new Error('not a valid RIFF file');
    if (wavData.toString('ascii', 8, 12) !== 'WAVE')
        throw new Error('not a valid WAVE file');
    if (hasAigcChunk(wavData))
        return wavData;
    const aigcSize = metadataJson.length;
    const needPadding = aigcSize % 2 !== 0;
    const aigcChunkBytes = 8 + aigcSize + (needPadding ? 1 : 0);
    const insertPos = findWavInsertPosition(wavData);
    // Splice: original[..insertPos] + AIGC chunk + original[insertPos..]
    const header = Buffer.alloc(8);
    header.write('AIGC', 0, 'ascii');
    header.writeUInt32LE(aigcSize, 4);
    const parts = [wavData.subarray(0, insertPos), header, metadataJson];
    if (needPadding)
        parts.push(Buffer.from([0]));
    parts.push(wavData.subarray(insertPos));
    const result = Buffer.concat(parts);
    // Bump outer RIFF size header.
    const oldRiffSize = result.readUInt32LE(4);
    result.writeUInt32LE(oldRiffSize + aigcChunkBytes, 4);
    return result;
}
/**
 * Walk RIFF subchunks looking for an AIGC chunk. Returns true if
 * present. Respects RIFF padding (size is odd → +1 byte).
 *
 * Byte-identical to storage-gateway hasAIGCChunk (L2118-2139).
 */
function hasAigcChunk(data) {
    let pos = 12; // skip RIFF+size+WAVE
    while (pos + 8 <= data.length) {
        const chunkId = data.toString('ascii', pos, pos + 4);
        const chunkSize = data.readUInt32LE(pos + 4);
        if (chunkId === 'AIGC')
            return true;
        let nextPos = pos + 8 + chunkSize;
        if (chunkSize % 2 !== 0)
            nextPos++;
        pos = nextPos;
    }
    return false;
}
/**
 * Find offset before the "data" chunk header for AIGC insertion.
 * Returns `data.length` if no "data" chunk found (EOF insert).
 *
 * Byte-identical to storage-gateway findWAVInsertPosition (L2143-2164).
 */
function findWavInsertPosition(data) {
    let pos = 12;
    while (pos + 8 <= data.length) {
        const chunkId = data.toString('ascii', pos, pos + 4);
        const chunkSize = data.readUInt32LE(pos + 4);
        if (chunkId === 'data')
            return pos;
        let nextPos = pos + 8 + chunkSize;
        if (chunkSize % 2 !== 0)
            nextPos++;
        pos = nextPos;
    }
    return data.length;
}
//# sourceMappingURL=audio.js.map