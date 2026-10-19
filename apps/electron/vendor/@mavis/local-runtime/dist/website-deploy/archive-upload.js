import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import JSZip from 'jszip';
import { deployFailure, ensureNotAborted, runDeployStage } from './deploy-failure.js';
const GET_UPLOAD_URL_PATH = '/mavis/api/v1/mcp/get_upload_url';
const ARCHIVE_MIME = 'application/zip';
/** Default exclusions keep dev output and credentials out of public archives. */
export const DEFAULT_IGNORE_PATTERNS = [
    /^\.git$/u,
    /^node_modules$/u,
    /^\.DS_Store$/u,
    /^\.env(\..+)?$/u,
];
/**
 * Recursively walks a deploy root while omitting ignored entries and symlinks.
 * Relative paths always use POSIX separators for the backend archive contract.
 */
export async function walkDeployableFiles(rootDir, ignorePatterns = DEFAULT_IGNORE_PATTERNS, excludedDir) {
    const rootReal = await realpath(rootDir);
    const excludedReal = excludedDir ? await realpath(excludedDir) : undefined;
    if (excludedReal && (rootReal === excludedReal || isPathInside(excludedReal, rootReal))) {
        return [];
    }
    const out = [];
    const stack = [rootReal];
    while (stack.length > 0) {
        const dir = stack.pop();
        if (dir === undefined)
            break;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const ent of entries) {
            if (ignorePatterns.some((re) => re.test(ent.name)))
                continue;
            const abs = join(dir, ent.name);
            if (ent.isSymbolicLink())
                continue;
            if (ent.isDirectory()) {
                const realDir = await realpath(abs);
                if (excludedReal && realDir === excludedReal)
                    continue;
                stack.push(realDir);
                continue;
            }
            if (!ent.isFile())
                continue;
            const st = await lstat(abs);
            if (!st.isFile())
                continue;
            const relPath = relative(rootReal, abs).split(sep).join('/');
            out.push({ absPath: abs, relPath, bytes: st.size });
        }
    }
    return out;
}
export async function uploadArchive(input) {
    const packagingStage = input.source ? 'upload_source' : 'upload_site';
    ensureNotAborted(input.signal, `before ${input.source ? 'source' : 'site'} upload`, packagingStage);
    const archive = await runDeployStage(packagingStage, input.signal, () => packZip(input.files, input.signal, packagingStage));
    const uploadUrlStage = input.source
        ? 'get_upload_url_source'
        : 'get_upload_url';
    const presigned = (await runDeployStage(uploadUrlStage, input.signal, () => input.gateway.postGatewayJson(GET_UPLOAD_URL_PATH, {
        filename: input.archiveName,
        mime_type: ARCHIVE_MIME,
        size_bytes: archive.byteLength,
        category: 'website',
    }, input.signal, input.timeoutMs)));
    if ((presigned.code ?? 0) !== 0 || !presigned.put_url || !presigned.oss_key) {
        const detail = presigned.error || presigned.message || 'no put_url/oss_key returned';
        throw deployFailure(`website_deploy ${uploadUrlStage} failed: code=${presigned.code ?? 'unknown'} ${detail}`, 'upload_url_rejected', uploadUrlStage);
    }
    const putUrl = presigned.put_url;
    const ossKey = presigned.oss_key;
    if (input.differentFromOssKey === ossKey) {
        throw deployFailure('website_deploy get_upload_url_source returned the public site archive key.', 'upload_url_rejected', uploadUrlStage);
    }
    const uploadStage = input.source
        ? 'upload_source_archive'
        : 'upload_archive';
    await runDeployStage(uploadStage, input.signal, () => input.gateway.putBytes(putUrl, 
    // Normalize Buffer<ArrayBufferLike> for Node 22's DOM BodyInit type;
    // the archive bytes are unchanged.
    new Uint8Array(archive), { 'Content-Type': ARCHIVE_MIME }, input.signal, input.timeoutMs));
    return { ossKey };
}
function isPathInside(parent, candidate) {
    const rel = relative(parent, candidate);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function packZip(files, signal, stage) {
    const zip = new JSZip();
    for (const file of files) {
        ensureNotAborted(signal, 'during packaging', stage);
        zip.file(file.relPath, createReadStream(file.absPath));
    }
    const archive = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
    ensureNotAborted(signal, 'after packaging', stage);
    return archive;
}
export function totalBytes(files) {
    return files.reduce((sum, file) => sum + file.bytes, 0);
}
export function sanitizeStem(name) {
    return name.replace(/[^A-Za-z0-9_-]/gu, '_').replace(/^_+|_+$/gu, '');
}
//# sourceMappingURL=archive-upload.js.map