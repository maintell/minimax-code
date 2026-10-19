import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../persistence/layout/v2-paths.js';
import { resolveSymlinkTargetPath, toWorkspaceRelativePath } from './collection-policy.js';
const BINARY_SAMPLE_BYTES = 8 * 1024;
export async function scanWorkspaceFiles(input) {
    const collected = await collectWorkspaceCandidates(input);
    if (collected.status === 'skipped_limit')
        return collected;
    const { candidates, inventoryFingerprint } = collected;
    const files = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
        input.signal?.throwIfAborted();
        if ('entry' in candidate) {
            files.push(candidate.entry);
            continue;
        }
        const hashed = await hashFile(candidate.sourcePath, input.signal);
        const after = await lstat(candidate.sourcePath).catch((error) => {
            if (error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        const afterRealPath = await realpath(candidate.sourcePath).catch(() => undefined);
        if (!after?.isFile() ||
            !afterRealPath ||
            !isPathInside(input.workspaceRealPath, afterRealPath) ||
            path.resolve(candidate.sourceRealPath) !== path.resolve(afterRealPath) ||
            candidate.size !== after.size ||
            candidate.mtimeMs !== after.mtimeMs ||
            candidate.ctimeMs !== after.ctimeMs ||
            candidate.ino !== after.ino ||
            hashed.size !== after.size) {
            throw new Error(`workspace_changed_during_scan:${candidate.path}`);
        }
        if (!input.includeBinaryArtifacts && isBinarySample(hashed.sample))
            continue;
        totalBytes += hashed.size;
        files.push({
            path: candidate.path,
            sourcePath: candidate.sourcePath,
            kind: 'file',
            size: hashed.size,
            mode: candidate.mode,
            sha256: hashed.sha256,
        });
    }
    return { status: 'ready', files, totalBytes, inventoryFingerprint };
}
export async function fingerprintWorkspaceFiles(input) {
    const collected = await collectWorkspaceCandidates(input);
    if (collected.status === 'skipped_limit')
        return collected;
    return { status: 'ready', inventoryFingerprint: collected.inventoryFingerprint };
}
async function collectWorkspaceCandidates(input) {
    const candidates = [];
    const inventoryMetadata = [];
    let observedBytes = 0;
    const excludesRealPath = (realPath) => {
        if (!input.isExcludedPath)
            return false;
        const resolved = toWorkspaceRelativePath(input.workspaceRealPath, realPath);
        return resolved !== undefined && input.isExcludedPath(resolved);
    };
    for (const relativePath of input.paths) {
        input.signal?.throwIfAborted();
        if (input.isExcludedPath?.(relativePath))
            continue;
        const sourcePath = path.join(input.workspaceRealPath, ...relativePath.split('/'));
        const before = await lstat(sourcePath).catch((error) => {
            if (error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        if (!before)
            continue;
        const mode = before.mode & 0o777;
        if (before.isSymbolicLink()) {
            const targetRealPath = await realpath(sourcePath).catch(() => undefined);
            const linkTarget = await readlink(sourcePath).catch(() => undefined);
            const capturable = Boolean(targetRealPath &&
                isPathInside(input.workspaceRealPath, targetRealPath) &&
                linkTarget &&
                !path.isAbsolute(linkTarget));
            if (!capturable || !linkTarget || !targetRealPath)
                continue;
            // The link records where it points; an excluded destination stays
            // excluded even when the link itself sits in an allowed directory.
            if (excludesRealPath(targetRealPath))
                continue;
            // The upload gate judges a stored symlink by its *lexical* target, the
            // path a restore would recreate. Admitting on the resolved target alone
            // could therefore mint a manifest that the very policy which produced it
            // rejects, parking the Revision on a hold no workspace edit can clear.
            const lexicalTarget = resolveSymlinkTargetPath(relativePath, linkTarget);
            if (lexicalTarget !== undefined && input.isExcludedPath?.(lexicalTarget))
                continue;
            inventoryMetadata.push([
                'symlink',
                relativePath,
                mode,
                before.mtimeMs,
                before.ctimeMs,
                before.ino,
                linkTarget,
                targetRealPath,
            ]);
            candidates.push({
                entry: {
                    path: relativePath,
                    sourcePath,
                    kind: 'symlink',
                    size: 0,
                    mode,
                    linkTarget,
                    sha256: sha256(Buffer.from(`symlink\0${linkTarget}`, 'utf8')),
                },
            });
        }
        else if (before.isFile() && before.size <= input.maxFileBytes) {
            const sourceRealPath = await realpath(sourcePath).catch(() => undefined);
            const capturable = Boolean(sourceRealPath && isPathInside(input.workspaceRealPath, sourceRealPath));
            if (!capturable || !sourceRealPath)
                continue;
            if (excludesRealPath(sourceRealPath))
                continue;
            inventoryMetadata.push([
                'file',
                relativePath,
                before.size,
                mode,
                before.mtimeMs,
                before.ctimeMs,
                before.ino,
                sourceRealPath,
            ]);
            observedBytes += before.size;
            if (observedBytes > input.maxTotalBytes) {
                return {
                    status: 'skipped_limit',
                    reason: 'total_bytes',
                    limit: input.maxTotalBytes,
                    observed: observedBytes,
                };
            }
            candidates.push({
                path: relativePath,
                sourcePath,
                sourceRealPath,
                size: before.size,
                mode,
                mtimeMs: before.mtimeMs,
                ctimeMs: before.ctimeMs,
                ino: before.ino,
            });
        }
        else {
            continue;
        }
        if (candidates.length > input.maxFiles) {
            return {
                status: 'skipped_limit',
                reason: 'file_count',
                limit: input.maxFiles,
                observed: candidates.length,
            };
        }
    }
    return {
        status: 'ready',
        candidates,
        inventoryFingerprint: sha256(Buffer.from(JSON.stringify(inventoryMetadata), 'utf8')),
    };
}
async function hashFile(sourcePath, signal) {
    const hash = createHash('sha256');
    const samples = [];
    let sampleBytes = 0;
    let size = 0;
    const stream = createReadStream(sourcePath, signal ? { signal } : undefined);
    for await (const chunk of stream) {
        signal?.throwIfAborted();
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        size += bytes.byteLength;
        if (sampleBytes < BINARY_SAMPLE_BYTES) {
            const sample = bytes.subarray(0, BINARY_SAMPLE_BYTES - sampleBytes);
            samples.push(sample);
            sampleBytes += sample.byteLength;
        }
    }
    return {
        sha256: hash.digest('hex'),
        size,
        sample: Buffer.concat(samples, sampleBytes),
    };
}
function isBinarySample(sample) {
    if (sample.length === 0)
        return false;
    if (sample.includes(0))
        return true;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample);
        return false;
    }
    catch {
        return true;
    }
}
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
//# sourceMappingURL=workspace-scan-files.js.map