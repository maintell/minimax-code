import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceIndexingPaths } from '../../../../infra/legacy-db/workspace-indexing-paths.js';
import { toManifestEntry } from '../scan/scanner.js';
import { WORKSPACE_MANIFEST_SCHEMA_VERSION, } from '../../../../infra/legacy-db/workspace-indexing-types.js';
import { writeWorkspaceArchive, } from '../scan/workspace-archive-writer.js';
export async function createWorkspaceCapture(input) {
    input.signal?.throwIfAborted();
    validateCaptureChain(input);
    const paths = resolveWorkspaceIndexingPaths({
        dataDir: input.dataDir,
        workspaceId: input.scan.workspaceId,
        sessionId: input.sessionId,
        revisionId: input.revisionId,
    });
    const entries = input.scan.files.map(toManifestEntry);
    const changeSet = diffWorkspaceEntries(input.previousManifest?.entries ?? [], entries);
    const includedPaths = input.kind === 'initial'
        ? new Set(entries.map((entry) => entry.path))
        : new Set([...changeSet.added, ...changeSet.modified]);
    await mkdir(paths.sessionCapturesRoot, { recursive: true, mode: 0o700 });
    await chmod(paths.sessionCapturesRoot, 0o700);
    const temporaryDir = path.join(paths.sessionCapturesRoot, `.capture-tmp-${randomUUID()}`);
    await mkdir(temporaryDir, { recursive: false, mode: 0o700 });
    const temporaryArchivePath = path.join(temporaryDir, 'workspace.zip');
    const temporaryManifestPath = path.join(temporaryDir, 'manifest.json');
    const sourceStagingDir = path.join(temporaryDir, '.source-staging');
    let published = false;
    try {
        input.signal?.throwIfAborted();
        const archive = await (input.archiveWriter ?? writeWorkspaceArchive)({
            targetPath: temporaryArchivePath,
            stagingDir: sourceStagingDir,
            scan: input.scan,
            includedPaths,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        await rm(sourceStagingDir, { recursive: true, force: true });
        const manifest = {
            schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
            workspaceId: input.scan.workspaceId,
            sessionId: input.sessionId,
            revisionId: input.revisionId,
            kind: input.kind,
            createdAtMs: input.createdAtMs ?? Date.now(),
            rootHash: input.scan.rootHash,
            ...(input.previousManifest
                ? {
                    baseRevisionId: input.previousManifest.revisionId,
                    baseRootHash: input.previousManifest.rootHash,
                }
                : {}),
            fileCount: entries.length,
            totalBytes: input.scan.totalBytes,
            entries,
            archive: {
                filename: 'workspace.zip',
                sha256: archive.sha256,
                sizeBytes: archive.sizeBytes,
            },
        };
        await chmod(temporaryArchivePath, 0o600);
        await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
            mode: 0o600,
        });
        await chmod(temporaryManifestPath, 0o600);
        input.signal?.throwIfAborted();
        await renameWithRetry(temporaryDir, paths.captureDir, input.publishCapture ?? ((source, target) => rename(source, target)));
        published = true;
        input.signal?.throwIfAborted();
        return {
            captureDir: paths.captureDir,
            archivePath: paths.archivePath,
            manifestPath: paths.manifestPath,
            archiveSha256: archive.sha256,
            manifest,
            changeSet,
        };
    }
    catch (error) {
        if (published)
            await rm(paths.captureDir, { recursive: true, force: true });
        await rm(temporaryDir, { recursive: true, force: true });
        throw error;
    }
}
async function renameWithRetry(sourcePath, targetPath, publish, maxRetries = 3) {
    for (let attempt = 0;; attempt += 1) {
        try {
            await publish(sourcePath, targetPath);
            return;
        }
        catch (error) {
            const code = error.code;
            if ((code === 'EPERM' || code === 'EACCES') && attempt < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
                continue;
            }
            throw error;
        }
    }
}
function diffWorkspaceEntries(previous, current) {
    const previousByPath = new Map(previous.map((entry) => [entry.path, entry]));
    const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
    const added = [];
    const modified = [];
    const deleted = [];
    for (const entry of current) {
        const before = previousByPath.get(entry.path);
        if (!before) {
            added.push(entry.path);
        }
        else if (!sameManifestEntry(before, entry)) {
            modified.push(entry.path);
        }
    }
    for (const entry of previous) {
        if (!currentByPath.has(entry.path))
            deleted.push(entry.path);
    }
    return { added, modified, deleted };
}
function validateCaptureChain(input) {
    if (input.kind === 'initial' && input.previousManifest) {
        throw new Error('workspace_initial_capture_cannot_have_base');
    }
    if (input.kind === 'revision' && !input.previousManifest) {
        throw new Error('workspace_revision_requires_base');
    }
    if (input.previousManifest &&
        (input.previousManifest.workspaceId !== input.scan.workspaceId ||
            input.previousManifest.sessionId !== input.sessionId)) {
        throw new Error('workspace_capture_base_mismatch');
    }
}
function sameManifestEntry(left, right) {
    if (left.kind !== right.kind ||
        left.path !== right.path ||
        left.mode !== right.mode ||
        left.size !== right.size ||
        left.sha256 !== right.sha256) {
        return false;
    }
    return left.kind === 'file' || right.kind === 'file'
        ? left.kind === right.kind
        : left.linkTarget === right.linkTarget;
}
//# sourceMappingURL=capture.js.map