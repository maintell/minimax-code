// FFmpeg subprocess helper — temp file lifecycle + spawn wrapper.
//
// Both audio.ts and video.ts need to:
//   1. Stage a Buffer to a temp file (ffmpeg `-i` cannot read stdin
//      for arbitrary containers).
//   2. Reserve a temp file path for ffmpeg's `-y <output>` flag.
//   3. Spawn ffmpeg with ctx-aware cancellation (caller can abort the
//      subprocess via AbortSignal).
//   4. Clean up temp files even on error or cancellation.
//
// Shared here so audio.ts and video.ts stay focused on per-format
// flag assembly, and so the cleanup discipline (defer-style) lives in
// one place.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
/** Default ffmpeg subprocess timeout (sec). 120s matches the watermark
 *  client timeout — same upper-bound for `-codec copy` on ~100 MB media. */
export const FFMPEG_TIMEOUT_MS = 120_000;
/** Demuxers behind every extension audio.ts / video.ts route to ffmpeg
 *  (mov covers mp4/m4a, matroska covers webm). */
const FFMPEG_INPUT_FORMATS = 'mov,matroska,flv,aac,flac,ogg';
/**
 * `-i <inFile>` preceded by input-side hardening. The bytes come from the
 * user's sandbox, so a playlist/concat file disguised under a media extension
 * must not make ffmpeg open other paths (e.g. sibling temp files of other
 * sessions) or the network: only the local `file` protocol and the demuxers
 * of the supported extensions are allowed.
 */
export function ffmpegInputArgs(inFile) {
    return ['-protocol_whitelist', 'file', '-format_whitelist', FFMPEG_INPUT_FORMATS, '-i', inFile];
}
/**
 * Create a temp file from `pattern` and write `data`. Returns the
 * full path plus a cleanup function. Cleanup is safe to call
 * multiple times; missing-file errors are swallowed.
 *
 * Pattern conventions:
 *   - Use `*` as the random-id placeholder (matches Go os.CreateTemp).
 *   - Include the desired extension so ffmpeg picks the right demuxer
 *     (e.g. `audio-input-*.wav`, `video-input-*.mp4`).
 */
export async function writeTempFile(pattern, data) {
    const filePath = makeTempPath(pattern);
    await fs.writeFile(filePath, data);
    return { path: filePath, cleanup: () => safeUnlink(filePath) };
}
/**
 * Reserve an empty temp file path for ffmpeg `-y <output>`. The file
 * is created (zero-byte) so the path is guaranteed unique, then
 * immediately closed — ffmpeg overwrites with `-y`.
 */
export async function reserveTempFile(pattern) {
    const filePath = makeTempPath(pattern);
    await fs.writeFile(filePath, '');
    return { path: filePath, cleanup: () => safeUnlink(filePath) };
}
/**
 * Spawn ffmpeg with the supplied args and wait for exit. Honours an
 * optional AbortSignal so the caller can cancel via ctx-style API.
 *
 * @param args — ffmpeg argv (without the binary name itself).
 * @param opts.signal — optional AbortSignal; on abort, ffmpeg is
 *   SIGKILL'd and the promise rejects with the abort reason.
 * @param opts.timeoutMs — kill ffmpeg after this many ms (default
 *   FFMPEG_TIMEOUT_MS).
 * @throws Error with the ffmpeg stderr tail (last ~500 chars) on
 *   non-zero exit, timeout, or spawn failure.
 */
export async function runFfmpeg(args, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? FFMPEG_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
        // Short-circuit if caller already aborted — avoid spawning ffmpeg at all.
        if (opts.signal?.aborted) {
            reject(new Error(`ffmpeg aborted before spawn: ${opts.signal.reason ?? 'aborted'}`));
            return;
        }
        // Minimal env: ffmpeg only needs PATH; do not hand it the host's credentials.
        const child = spawn('ffmpeg', ['-loglevel', 'error', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        });
        let stderr = '';
        let stdout = '';
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
            if (stderr.length > 4096)
                stderr = stderr.slice(-4096);
        });
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > 4096)
                stdout = stdout.slice(-4096);
        });
        let settled = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const abortHandler = () => {
            child.kill('SIGKILL');
            finish(new Error(`ffmpeg aborted: ${opts.signal?.reason ?? 'aborted'}`));
        };
        if (opts.signal) {
            opts.signal.addEventListener('abort', abortHandler);
        }
        const finish = (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', abortHandler);
            if (err)
                reject(err);
            else
                resolve();
        };
        child.on('error', (err) => {
            finish(new Error(`ffmpeg spawn failed: ${err.message}`));
        });
        child.on('close', (code) => {
            if (code === 0) {
                finish(null);
            }
            else {
                const tail = stderr.trim().slice(-500) || stdout.trim().slice(-500);
                finish(new Error(`ffmpeg exit=${code}: ${tail}`));
            }
        });
    });
}
function makeTempPath(pattern) {
    const dir = os.tmpdir();
    const star = pattern.indexOf('*');
    const randomId = randomBytes(8).toString('hex');
    const name = star >= 0
        ? pattern.slice(0, star) + randomId + pattern.slice(star + 1)
        : `${pattern}-${randomId}`;
    return path.join(dir, name);
}
async function safeUnlink(p) {
    try {
        await fs.unlink(p);
    }
    catch {
        /* ignore missing / already-removed */
    }
}
//# sourceMappingURL=ffmpeg.js.map