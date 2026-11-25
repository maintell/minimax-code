// Video AIGC injector — MP4/MOV/MKV/WebM/FLV via ffmpeg subprocess.
//
// Wire format aligned with storage-gateway video.go + mcp-server
// injectors/video.py. All video formats use FLAT JSON (no
// `{"AIGC": {...}}` wrapper). Per-format flag set:
//
//   .mp4, .mov   → -movflags use_metadata_tags  -codec copy
//                  (writes moov.udta.meta)
//   .mkv, .webm  → -codec copy   (writes Matroska Tags)
//   .flv         → -codec copy   (writes onMetaData ScriptDataObject)
//
// `-codec copy` skips re-encoding so the operation is near-instant on
// large files (only the container metadata changes; the encoded video
// payload is preserved bit-for-bit). This also keeps SM2 signatures
// over the input bytes meaningful for downstream verification.
//
// AVI is NOT supported — storage-gateway's AVI path uses a manual RIFF
// LIST/INFO patcher (~250 LOC); Mavis does not emit AVI assets.
// Re-add via a follow-up port if the need arises.
//
// ffmpeg failures (non-zero exit, timeout, signal abort) bubble as
// thrown errors; the inject.ts dispatcher wraps the call in a try/catch
// to apply fail-open passthrough semantics to the calling tool.
import { promises as fs } from 'node:fs';
import { ffmpegInputArgs, reserveTempFile, runFfmpeg, writeTempFile, FFMPEG_TIMEOUT_MS, } from './ffmpeg.js';
/** Video extensions supported by this module (lowercase, with leading dot). */
const SUPPORTED_VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.flv']);
/**
 * Inject AIGCInfo into video bytes via ffmpeg `-metadata AIGC=<json>`.
 * Returns the rewritten bytes. Throws on unsupported extension or
 * ffmpeg failure.
 *
 * @param data — input video bytes.
 * @param ext — lowercase extension with leading dot (e.g. ".mp4").
 * @param info — flat AIGCInfo (caller has already filled signatures
 *   via sm2.fillSignatures if applicable).
 * @param opts.signal — propagate AbortSignal to ffmpeg subprocess so
 *   caller cancellation aborts the running ffmpeg.
 * @param opts.timeoutMs — override default ffmpeg timeout.
 */
export async function injectVideo(data, ext, info, opts = {}) {
    const normalisedExt = ext.toLowerCase();
    if (!SUPPORTED_VIDEO_EXT.has(normalisedExt)) {
        throw new Error(`unsupported video extension: ${ext}`);
    }
    const flatJson = JSON.stringify(info);
    const inFile = await writeTempFile(`mavis-metainfo-video-in-*${normalisedExt}`, data);
    const outFile = await reserveTempFile(`mavis-metainfo-video-out-*${normalisedExt}`);
    try {
        const args = [...ffmpegInputArgs(inFile.path), '-metadata', `AIGC=${flatJson}`];
        if (normalisedExt === '.mp4' || normalisedExt === '.mov') {
            args.push('-movflags', 'use_metadata_tags');
        }
        args.push('-codec', 'copy', '-y', outFile.path);
        await runFfmpeg(args, {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs ?? FFMPEG_TIMEOUT_MS,
        });
        return await fs.readFile(outFile.path);
    }
    finally {
        await inFile.cleanup();
        await outFile.cleanup();
    }
}
//# sourceMappingURL=video.js.map