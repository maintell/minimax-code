import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../../../../infra/legacy-db/v2-paths.js';
import { resolveSymlinkTargetPath, toWorkspaceRelativePath } from '../capture/collection-policy.js';
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
        await verifyScannedFile(candidate, input.workspaceRealPath, hashed.size);
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
    for (const relativePath of input.paths) {
        input.signal?.throwIfAborted();
        const collected = await collectWorkspaceCandidate(input, relativePath);
        if (!collected)
            continue;
        const { candidate, metadata } = collected;
        inventoryMetadata.push(metadata);
        if (!('entry' in candidate)) {
            observedBytes += candidate.size;
            if (observedBytes > input.maxTotalBytes) {
                return {
                    status: 'skipped_limit',
                    reason: 'total_bytes',
                    limit: input.maxTotalBytes,
                    observed: observedBytes,
                };
            }
        }
        candidates.push(candidate);
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
async function statIfPresent(sourcePath) {
    try {
        return await lstat(sourcePath);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
async function resolveRealPath(sourcePath) {
    try {
        return await realpath(sourcePath);
    }
    catch {
        return undefined;
    }
}
async function readLinkTarget(sourcePath) {
    try {
        return await readlink(sourcePath);
    }
    catch {
        return undefined;
    }
}
async function verifyScannedFile(candidate, workspaceRealPath, hashedSize) {
    const after = await statIfPresent(candidate.sourcePath);
    const afterRealPath = await resolveRealPath(candidate.sourcePath);
    if (!after?.isFile() ||
        !afterRealPath ||
        !isPathInside(workspaceRealPath, afterRealPath) ||
        path.resolve(candidate.sourceRealPath) !== path.resolve(afterRealPath) ||
        candidate.size !== after.size ||
        candidate.mtimeMs !== after.mtimeMs ||
        candidate.ctimeMs !== after.ctimeMs ||
        candidate.ino !== after.ino ||
        hashedSize !== after.size) {
        throw new Error(`workspace_changed_during_scan:${candidate.path}`);
    }
}
function excludesRealPath(input, realPath) {
    if (!input.isExcludedPath)
        return false;
    const resolved = toWorkspaceRelativePath(input.workspaceRealPath, realPath);
    return resolved !== undefined && input.isExcludedPath(resolved);
}
async function collectWorkspaceCandidate(input, relativePath) {
    if (input.isExcludedPath?.(relativePath))
        return undefined;
    const sourcePath = path.join(input.workspaceRealPath, ...relativePath.split('/'));
    const before = await statIfPresent(sourcePath);
    if (!before)
        return undefined;
    if (before.isSymbolicLink()) {
        return collectSymlinkCandidate(input, relativePath, sourcePath, before);
    }
    if (!before.isFile() || before.size > input.maxFileBytes)
        return undefined;
    const sourceRealPath = await resolveRealPath(sourcePath);
    if (!sourceRealPath || !isPathInside(input.workspaceRealPath, sourceRealPath))
        return undefined;
    if (excludesRealPath(input, sourceRealPath))
        return undefined;
    const mode = before.mode & 0o777;
    return {
        metadata: [
            'file',
            relativePath,
            before.size,
            mode,
            before.mtimeMs,
            before.ctimeMs,
            before.ino,
            sourceRealPath,
        ],
        candidate: {
            path: relativePath,
            sourcePath,
            sourceRealPath,
            size: before.size,
            mode,
            mtimeMs: before.mtimeMs,
            ctimeMs: before.ctimeMs,
            ino: before.ino,
        },
    };
}
async function collectSymlinkCandidate(input, relativePath, sourcePath, before) {
    const targetRealPath = await resolveRealPath(sourcePath);
    const linkTarget = await readLinkTarget(sourcePath);
    if (!targetRealPath || !isPathInside(input.workspaceRealPath, targetRealPath))
        return undefined;
    if (!linkTarget || path.isAbsolute(linkTarget))
        return undefined;
    // A link's resolved destination and the lexical target recreated on restore
    // must both satisfy the same collection policy as the inventory path.
    if (excludesRealPath(input, targetRealPath))
        return undefined;
    const lexicalTarget = resolveSymlinkTargetPath(relativePath, linkTarget);
    if (lexicalTarget !== undefined && input.isExcludedPath?.(lexicalTarget))
        return undefined;
    const mode = before.mode & 0o777;
    return {
        metadata: [
            'symlink',
            relativePath,
            mode,
            before.mtimeMs,
            before.ctimeMs,
            before.ino,
            linkTarget,
            targetRealPath,
        ],
        candidate: {
            entry: {
                path: relativePath,
                sourcePath,
                kind: 'symlink',
                size: 0,
                mode,
                linkTarget,
                sha256: sha256(Buffer.from(`symlink\0${linkTarget}`, 'utf8')),
            },
        },
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