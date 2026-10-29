import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { READ_MAX_LINE_CHARS } from '@mavis/agent-tools/read-contract';
const TOOL_OUTPUT_DIRECTORY = 'tool-outputs';
// A worst-case JSON escape uses six characters (for example, "\u0000").
// 240 code points plus the JSONL envelope therefore stays below the read cap.
const READABLE_CHUNK_CODE_POINTS = 240;
const READABLE_WRITE_BATCH_BYTES = 64 * 1_024;
const READABLE_FORMAT_VERSION = 1;
const READABLE_FORMAT = `chunked_jsonl_v${READABLE_FORMAT_VERSION}`;
// At most 64 KiB for one UTF-8 conversion even if every UTF-16 code unit is
// encoded independently as a three-byte replacement character.
const RAW_WRITE_CHUNK_CODE_UNITS = 16 * 1_024;
/** Located read-grant paths kept per process; each entry is a short path pair. */
const READABLE_DIRECTORY_CACHE_LIMIT = 512;
/** Persists oversized tool text under the Session-owned reports directory. */
export class ToolOutputArtifactRepository {
    options;
    readableDirectories = new Map();
    constructor(options) {
        this.options = options;
    }
    async write(input) {
        const canonicalDirectory = await this.resolveDirectory(input.sessionId);
        const identity = artifactIdentity(input);
        const artifactPath = join(canonicalDirectory, identity.fileName);
        await ensureRawArtifact(artifactPath, input.text, identity.contentSha256);
        if (hasLineExceedingReadLimit(input.text)) {
            const readablePath = join(canonicalDirectory, identity.readableFileName);
            await ensureReadableArtifact(readablePath, input.text, {
                originalBytes: Buffer.byteLength(input.text),
                contentSha256: identity.contentSha256,
            });
            return {
                reference: readablePath,
                metadata: {
                    artifact_kind: 'tool_output',
                    sensitive: input.sensitive,
                    content_sha256: identity.contentSha256,
                    read_format: READABLE_FORMAT,
                    raw_reference: artifactPath,
                },
            };
        }
        return {
            reference: artifactPath,
            metadata: {
                artifact_kind: 'tool_output',
                sensitive: input.sensitive,
                content_sha256: identity.contentSha256,
            },
        };
    }
    /** Persists a tool result image so history can name a file instead of carrying it. */
    async writeImage(input) {
        const canonicalDirectory = await this.resolveDirectory(input.sessionId);
        const bytes = Buffer.from(input.data, 'base64');
        const contentSha256 = createHash('sha256').update(bytes).digest('hex');
        const artifactPath = join(canonicalDirectory, `${callDigest(input)}-${contentSha256}.${imageExtension(input.mimeType)}`);
        const expected = { bytes: bytes.length, sha256: contentSha256 };
        const existing = await readSafeFileInfo(artifactPath, 'Existing tool output image');
        if (existing) {
            await verifyArtifactInfo(artifactPath, existing, expected, 'Existing tool output image');
        }
        else {
            await publishArtifactAtomically(artifactPath, 'Existing tool output image', async (handle) => {
                await handle.writeFile(bytes);
                return expected;
            });
        }
        return { reference: artifactPath };
    }
    /** Where this Session's tool output is written; it may not exist yet. */
    async directory(sessionId) {
        return join(await this.options.resolveSessionReportsDirectory(sessionId), TOOL_OUTPUT_DIRECTORY);
    }
    /**
     * The Session's own tool-output directory, published to the permission layer
     * as the Session's read grant. The runtime hands the Agent a path when it
     * externalizes an oversized tool result, so the Agent must be able to read
     * that artifact back.
     *
     * Side-effect free: the location comes from a read-only lookup (no history
     * binding, no directory creation), so Sessions that never externalized a
     * result pay nothing. `undefined` means there is nothing to grant: the
     * Session is unknown, nothing has been written yet, or the directory fails
     * the same safety checks the writer applies.
     *
     * The grant is the located (lexical) path, never its realpath. Resolving it
     * here would erase any symlink swapped into an ancestor such as `reports/`
     * before the permission layer could see it; the permission layer
     * canonicalizes the lexical path itself and rejects a root reached through
     * any symlink below the private runtime root.
     *
     * Only the located path is cached, bounded by count. The directory itself is
     * re-validated on every call, so a deleted or swapped-in directory is never
     * granted from a stale cache entry.
     */
    async readableDirectory(sessionId) {
        const located = await this.locateReadableDirectory(sessionId);
        if (!located)
            return undefined;
        if (!(await isSafeExistingDirectory(located.reports, located.directory))) {
            this.readableDirectories.delete(sessionId);
            return undefined;
        }
        this.rememberReadableDirectory(sessionId, located);
        return located.directory;
    }
    async locateReadableDirectory(sessionId) {
        const cached = this.readableDirectories.get(sessionId);
        if (cached)
            return cached;
        const inspect = this.options.inspectSessionReportsDirectory;
        if (!inspect)
            return undefined;
        const reports = await inspect(sessionId);
        return reports ? { reports, directory: join(reports, TOOL_OUTPUT_DIRECTORY) } : undefined;
    }
    rememberReadableDirectory(sessionId, location) {
        // Refresh recency, then evict the least recently used entries.
        this.readableDirectories.delete(sessionId);
        this.readableDirectories.set(sessionId, location);
        while (this.readableDirectories.size > READABLE_DIRECTORY_CACHE_LIMIT) {
            const oldest = this.readableDirectories.keys().next().value;
            if (oldest === undefined)
                break;
            this.readableDirectories.delete(oldest);
        }
    }
    async resolveDirectory(sessionId) {
        const reportsDirectory = await this.options.resolveSessionReportsDirectory(sessionId);
        const directory = join(reportsDirectory, TOOL_OUTPUT_DIRECTORY);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const [canonicalReportsDirectory, canonicalDirectory] = await Promise.all([
            realpath(reportsDirectory),
            realpath(directory),
        ]);
        if (!isPathInside(canonicalDirectory, canonicalReportsDirectory)) {
            throw new Error('Tool output artifact directory escapes its Session reports directory.');
        }
        const directoryInfo = await lstat(canonicalDirectory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
            throw new Error('Tool output artifact directory is not a safe directory.');
        }
        return canonicalDirectory;
    }
}
function imageExtension(mimeType) {
    const subtype = mimeType.toLowerCase().split('/')[1]?.split(/[;+]/u)[0];
    if (subtype === 'jpeg')
        return 'jpg';
    return subtype && /^[a-z0-9]{1,8}$/u.test(subtype) ? subtype : 'bin';
}
function callDigest(input) {
    return createHash('sha256')
        .update(input.toolCallId)
        .update('\0')
        .update(input.toolName)
        .digest('hex')
        .slice(0, 24);
}
function isPathInside(candidate, parent) {
    const pathFromParent = relative(parent, candidate);
    return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}
/**
 * Whether an existing tool-output directory passes the writer's safety checks,
 * without creating anything: it must be a real directory (not a symlink) whose
 * canonical path stays inside the canonical reports directory. Symlinks in
 * higher ancestors are the permission layer's job (see `readableDirectory`).
 */
async function isSafeExistingDirectory(reportsDirectory, directory) {
    try {
        const directoryInfo = await lstat(directory);
        if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
            return false;
        const [canonicalReportsDirectory, canonicalDirectory] = await Promise.all([
            realpath(reportsDirectory),
            realpath(directory),
        ]);
        return isPathInside(canonicalDirectory, canonicalReportsDirectory);
    }
    catch (error) {
        if (isMissingPathError(error))
            return false;
        throw error;
    }
}
function isMissingPathError(error) {
    const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
    return code === 'ENOENT' || code === 'ENOTDIR';
}
function artifactIdentity(input) {
    // The reports directory already scopes artifacts to a Session. Exclude the
    // projecting turn so the same historical tool result keeps one stable path.
    const contentSha256 = sha256Text(input.text);
    const baseName = `${callDigest(input)}-${contentSha256}`;
    return {
        fileName: `${baseName}.txt`,
        readableFileName: `${baseName}.readable.v${READABLE_FORMAT_VERSION}.jsonl`,
        contentSha256,
    };
}
async function ensureRawArtifact(artifactPath, text, contentSha256) {
    const expected = { bytes: Buffer.byteLength(text), sha256: contentSha256 };
    const existing = await readSafeFileInfo(artifactPath, 'Existing tool output artifact');
    if (existing) {
        await verifyArtifactInfo(artifactPath, existing, expected, 'Existing tool output artifact');
        return;
    }
    await publishArtifactAtomically(artifactPath, 'Existing tool output artifact', (handle) => writeRawArtifact(handle, text));
}
function hasLineExceedingReadLimit(text) {
    let lineCodePoints = 0;
    for (const char of text) {
        if (char === '\n') {
            lineCodePoints = 0;
            continue;
        }
        lineCodePoints += 1;
        if (lineCodePoints > READ_MAX_LINE_CHARS)
            return true;
    }
    return false;
}
async function ensureReadableArtifact(artifactPath, text, identity) {
    const existing = await readSafeFileInfo(artifactPath, 'Existing readable tool output artifact');
    if (existing) {
        const expected = describeReadableArtifact(text, identity);
        await verifyArtifactInfo(artifactPath, existing, expected, 'Existing readable tool output artifact');
        return;
    }
    await publishArtifactAtomically(artifactPath, 'Existing readable tool output artifact', (handle) => writeReadableArtifact(handle, text, identity));
}
async function publishArtifactAtomically(artifactPath, existingLabel, writeTemporary) {
    const temporaryPath = `${artifactPath}.${process.pid}-${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
        let written;
        try {
            written = await writeTemporary(handle);
        }
        finally {
            await handle.close();
        }
        try {
            await link(temporaryPath, artifactPath);
        }
        catch (error) {
            if (!isAlreadyExists(error))
                throw error;
            await verifyArtifact(artifactPath, written.bytes, written.sha256, existingLabel);
        }
    }
    finally {
        await removeBestEffort(temporaryPath);
    }
}
async function writeRawArtifact(handle, text) {
    const hash = createHash('sha256');
    let bytes = 0;
    for (const chunk of boundedTextChunks(text)) {
        await handle.writeFile(chunk, 'utf8');
        hash.update(chunk);
        bytes += Buffer.byteLength(chunk);
    }
    return { bytes, sha256: hash.digest('hex') };
}
async function writeReadableArtifact(handle, text, identity) {
    const hash = createHash('sha256');
    let bytes = 0;
    let pending = '';
    let pendingBytes = 0;
    for (const line of readableArtifactLines(text, identity)) {
        const lineBytes = Buffer.byteLength(line);
        if (pendingBytes > 0 && pendingBytes + lineBytes > READABLE_WRITE_BATCH_BYTES) {
            await handle.writeFile(pending, 'utf8');
            pending = '';
            pendingBytes = 0;
        }
        pending += line;
        pendingBytes += lineBytes;
        hash.update(line);
        bytes += lineBytes;
    }
    if (pendingBytes > 0)
        await handle.writeFile(pending, 'utf8');
    return { bytes, sha256: hash.digest('hex') };
}
async function removeBestEffort(path) {
    try {
        await unlink(path);
    }
    catch {
        // A temporary cleanup failure must not replace the artifact result.
    }
}
function describeReadableArtifact(text, identity) {
    const hash = createHash('sha256');
    let bytes = 0;
    for (const line of readableArtifactLines(text, identity)) {
        hash.update(line);
        bytes += Buffer.byteLength(line);
    }
    return { bytes, sha256: hash.digest('hex') };
}
function* readableArtifactLines(text, identity) {
    yield `${JSON.stringify({
        type: 'tool_output_chunks',
        version: READABLE_FORMAT_VERSION,
        original_bytes: identity.originalBytes,
        content_sha256: identity.contentSha256,
        instruction: "Concatenate each chunk row's text field in index order.",
    })}\n`;
    let index = 0;
    let byteOffset = 0;
    let chunk = '';
    let chunkCodePoints = 0;
    for (const char of text) {
        chunk += char;
        chunkCodePoints += 1;
        if (chunkCodePoints < READABLE_CHUNK_CODE_POINTS)
            continue;
        yield encodeReadableChunk(index, byteOffset, chunk);
        byteOffset += Buffer.byteLength(chunk);
        index += 1;
        chunk = '';
        chunkCodePoints = 0;
    }
    if (chunk || text === '')
        yield encodeReadableChunk(index, byteOffset, chunk);
}
function encodeReadableChunk(index, byteOffset, text) {
    return `${JSON.stringify({ type: 'chunk', index, byte_offset: byteOffset, text })}\n`;
}
function sha256Text(text) {
    const hash = createHash('sha256');
    for (const chunk of boundedTextChunks(text))
        hash.update(chunk);
    return hash.digest('hex');
}
function* boundedTextChunks(text) {
    let start = 0;
    while (start < text.length) {
        let end = Math.min(start + RAW_WRITE_CHUNK_CODE_UNITS, text.length);
        if (end < text.length &&
            isHighSurrogate(text.charCodeAt(end - 1)) &&
            isLowSurrogate(text.charCodeAt(end))) {
            end -= 1;
        }
        yield text.slice(start, end);
        start = end;
    }
}
function isHighSurrogate(codeUnit) {
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}
function isLowSurrogate(codeUnit) {
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
async function verifyArtifact(artifactPath, expectedBytes, expectedSha256, label) {
    const existing = await readSafeFileInfo(artifactPath, label);
    if (!existing)
        throw new Error(`${label} disappeared during verification.`);
    await verifyArtifactInfo(artifactPath, existing, { bytes: expectedBytes, sha256: expectedSha256 }, label);
}
async function readSafeFileInfo(artifactPath, label) {
    try {
        const info = await lstat(artifactPath);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error(`${label} is not a safe file.`);
        }
        return info;
    }
    catch (error) {
        if (isNotFound(error))
            return undefined;
        throw error;
    }
}
async function verifyArtifactInfo(artifactPath, existing, expected, label) {
    if (existing.size !== expected.bytes || (await sha256File(artifactPath)) !== expected.sha256) {
        throw new Error(`${label} content does not match this result.`);
    }
}
function sha256File(path) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(path);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}
function isAlreadyExists(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'EEXIST');
}
function isNotFound(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT');
}
//# sourceMappingURL=tool-output-artifact.repository.js.map