import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, openAsBlob, realpath } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { SpaceError, sanitizeMessage } from './errors.js';
/** One object upload or download; matches the old CLI. */
export const SPACE_TRANSFER_TIMEOUT_MS = 10 * 60_000;
/**
 * JS realpath like `realpathSync`, not `fs.promises.realpath` (native realpath(3), which can resolve
 * mapped drives and junctions differently on Windows). Desktop keys session file syncs by the same
 * JS realpath, so `source_path` must match it.
 */
const resolveRealPath = promisify(realpath);
/** Stat and hash a local file without reading it into memory. */
export async function readLocalUploadFile(absolutePath) {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
        throw new SpaceError('INVALID_ARGS', `${absolutePath} is not a regular file.`);
    }
    const realPath = await resolveRealPath(absolutePath);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(realPath)) {
        const bytes = chunk;
        hash.update(bytes);
        size += bytes.length;
    }
    return { realPath, size, sha256: hash.digest('hex') };
}
/** Signed multipart form upload (PostObject); the file field goes last. */
export async function postObject(request, fetchImpl, signal) {
    const form = new FormData();
    for (const [key, value] of Object.entries(request.fields))
        form.append(key, value);
    form.append('file', await openAsBlob(request.filePath, { type: request.mimeType }), request.fileName);
    let response;
    try {
        response = await fetchImpl(request.url, {
            method: 'POST',
            body: form,
            signal: withTimeout(signal, SPACE_TRANSFER_TIMEOUT_MS),
        });
    }
    catch (error) {
        throw transferError('Upload', error);
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
        throw new SpaceError('UPSTREAM', `Upload failed: HTTP ${response.status}.`, true);
    }
}
/**
 * Stream a pre-signed URL to `destination` and return its SHA-256. The URL is fetched
 * without business credentials, written to a sibling temporary file and renamed into place
 * only after the whole body arrived. Errors never include the URL (its query is a credential).
 */
export async function downloadToFile(url, destination, fetchImpl, signal) {
    let response;
    try {
        response = await fetchImpl(url, { signal: withTimeout(signal, SPACE_TRANSFER_TIMEOUT_MS) });
    }
    catch (error) {
        throw transferError('Download', error);
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpaceError('UPSTREAM', `Download failed: HTTP ${response.status}.`, true);
    }
    if (!response.body) {
        throw new SpaceError('UPSTREAM', 'Download failed: empty response body.', true);
    }
    const hash = createHash('sha256');
    let bytes = 0;
    const tap = new Transform({
        transform(chunk, _encoding, callback) {
            hash.update(chunk);
            bytes += chunk.length;
            callback(null, chunk);
        },
    });
    const temporary = `${destination}.${randomBytes(4).toString('hex')}.part`;
    try {
        await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(temporary, { flags: 'wx' }));
        await rename(temporary, destination);
    }
    catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        if (isFileSystemError(error))
            throw error;
        throw transferError('Download', error);
    }
    return { sha256: hash.digest('hex'), bytes };
}
function transferError(label, error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
        return new SpaceError('UPSTREAM', `${label} timed out.`, true);
    }
    if (error instanceof Error && error.name === 'AbortError') {
        return new SpaceError('UPSTREAM', `${label} was cancelled.`, true);
    }
    const detail = error instanceof Error ? error.message : String(error);
    return new SpaceError('UPSTREAM', sanitizeMessage(`${label} failed: ${detail}`), true);
}
function withTimeout(signal, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
/** Local write failures carry the file path; socket errors do not. */
function isFileSystemError(value) {
    return (value instanceof Error &&
        typeof value.syscall === 'string' &&
        typeof value.path === 'string');
}
//# sourceMappingURL=transfer.js.map