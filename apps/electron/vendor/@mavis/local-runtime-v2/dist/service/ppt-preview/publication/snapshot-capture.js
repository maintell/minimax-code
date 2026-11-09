import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, mkdir, writeFile, rename, rm, } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { PptPreviewError, PPT_PREVIEW_LIMITS } from '@mavis/shared/ppt-preview';
import { readBoundedPresentation } from './zip-directory.js';
function contained(root, file) {
    const path = relative(root, file);
    return (path !== '..' &&
        !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(path));
}
function stableIdentity(before, after, named, length) {
    return [
        before.size === after.size,
        before.mtimeMs === after.mtimeMs,
        after.mtimeMs === named.mtimeMs,
        after.size === named.size,
        before.ino === named.ino,
        before.dev === named.dev,
        after.size === length,
    ].every(Boolean);
}
async function stableBytes(root, candidate) {
    const handle = await open(candidate, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > PPT_PREVIEW_LIMITS.maxSourceBytes)
            throw new PptPreviewError('LIMIT_EXCEEDED', 'PPTX source exceeds the input limit');
        const bytes = await readBoundedBytes(handle);
        const after = await handle.stat();
        const named = await stat(candidate);
        if (!stableIdentity(before, after, named, bytes.length) ||
            !contained(root, await realpath(candidate)))
            throw new PptPreviewError('SOURCE_MUTATED', 'PPTX changed while being captured');
        return bytes;
    }
    finally {
        await handle.close();
    }
}
async function readBoundedBytes(handle) {
    const chunks = [];
    let length = 0;
    const stream = handle.createReadStream({
        autoClose: false,
        start: 0,
        end: PPT_PREVIEW_LIMITS.maxSourceBytes,
    });
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > PPT_PREVIEW_LIMITS.maxSourceBytes)
            throw new PptPreviewError('LIMIT_EXCEEDED', 'PPTX source exceeds the input limit');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, length);
}
function countSlides(bytes) {
    let xml;
    try {
        xml = readBoundedPresentation(bytes).toString('utf8');
    }
    catch {
        throw new PptPreviewError('INVALID_PPTX', 'PPTX is not a complete bounded ZIP presentation');
    }
    if (/<!DOCTYPE|<!ENTITY/iu.test(xml))
        throw new PptPreviewError('INVALID_PPTX', 'XML entities are not supported');
    const count = (xml.match(/<(?:[\w.-]+:)?sldId\s/gu) ?? []).length;
    if (!count || count > PPT_PREVIEW_LIMITS.maxPages)
        throw new PptPreviewError('LIMIT_EXCEEDED', 'PPTX slide count is outside supported limits');
    return count;
}
/** Validates and hashes a workspace PPTX without writing a private copy. */
export async function readPptxSource(workspace, input) {
    const root = await realpath(workspace);
    const candidate = await realpath(resolve(root, input));
    if (!contained(root, candidate))
        throw new PptPreviewError('FILE_NOT_AUTHORIZED', 'PPTX must be inside the current session workspace');
    const bytes = await stableBytes(root, candidate);
    const slideCount = countSlides(bytes);
    const contentHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    return { bytes, contentHash, slideCount };
}
/** Persists an already validated source as an immutable private snapshot file. */
export async function writePptxSnapshot(source, destination) {
    const { bytes, contentHash, slideCount } = source;
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const snapshotId = randomUUID();
    const sourcePath = join(destination, `${snapshotId}.pptx`);
    const temporary = `${sourcePath}.tmp`;
    try {
        await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await rename(temporary, sourcePath);
    }
    catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
    return { snapshotId, sourcePath, contentHash, sizeBytes: bytes.length, slideCount };
}
export async function capturePptx(workspace, input, destination) {
    return writePptxSnapshot(await readPptxSource(workspace, input), destination);
}
//# sourceMappingURL=snapshot-capture.js.map