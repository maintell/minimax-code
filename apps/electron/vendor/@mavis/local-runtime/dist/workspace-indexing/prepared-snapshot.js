import { randomUUID } from 'node:crypto';
import { access, chmod, copyFile, link, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspaceIndexingPaths, resolveWorkspacePrewarmPaths } from './paths.js';
import { toManifestEntry } from './scanner.js';
import { WORKSPACE_MANIFEST_SCHEMA_VERSION, } from './types.js';
import { writeWorkspaceArchive } from './workspace-archive-writer.js';
export async function createWorkspacePreparedSnapshot(input) {
    input.signal?.throwIfAborted();
    const paths = resolveWorkspacePrewarmPaths({
        dataDir: input.dataDir,
        workspaceId: input.scan.workspaceId,
    });
    await mkdir(paths.prewarmRoot, { recursive: true, mode: 0o700 });
    await chmod(paths.prewarmRoot, 0o700);
    const temporaryDir = path.join(paths.prewarmRoot, `.prewarm-tmp-${randomUUID()}`);
    const stagingDir = path.join(temporaryDir, '.source-staging');
    const archivePath = path.join(temporaryDir, 'workspace.zip');
    const metadataPath = path.join(temporaryDir, 'snapshot.json');
    const backupDir = path.join(paths.prewarmRoot, `.prewarm-old-${randomUUID()}`);
    let previousMoved = false;
    let published = false;
    await mkdir(temporaryDir, { recursive: false, mode: 0o700 });
    try {
        const archive = await (input.archiveWriter ?? writeWorkspaceArchive)({
            targetPath: archivePath,
            stagingDir,
            scan: input.scan,
            includedPaths: new Set(input.scan.files.map((entry) => entry.path)),
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const createdAtMs = input.createdAtMs ?? Date.now();
        await chmod(archivePath, 0o600);
        await writeFile(metadataPath, `${JSON.stringify({
            schemaVersion: 1,
            workspaceId: input.scan.workspaceId,
            rootHash: input.scan.rootHash,
            inventoryFingerprint: input.scan.inventoryFingerprint,
            fileCount: input.scan.files.length,
            totalBytes: input.scan.totalBytes,
            createdAtMs,
            archive: {
                filename: 'workspace.zip',
                sha256: archive.sha256,
                sizeBytes: archive.sizeBytes,
            },
        }, null, 2)}\n`, { mode: 0o600 });
        input.signal?.throwIfAborted();
        if (await pathExists(paths.preparedDir)) {
            await renameWithRetry(paths.preparedDir, backupDir);
            previousMoved = true;
        }
        await renameWithRetry(temporaryDir, paths.preparedDir);
        published = true;
        await rm(backupDir, { recursive: true, force: true });
        return {
            preparedDir: paths.preparedDir,
            archivePath: paths.archivePath,
            metadataPath: paths.metadataPath,
            archiveSha256: archive.sha256,
            archiveSizeBytes: archive.sizeBytes,
            createdAtMs,
            scan: input.scan,
        };
    }
    catch (error) {
        if (!published && previousMoved && !(await pathExists(paths.preparedDir))) {
            await renameWithRetry(backupDir, paths.preparedDir).catch(() => undefined);
        }
        await rm(temporaryDir, { recursive: true, force: true });
        await rm(backupDir, { recursive: true, force: true });
        throw error;
    }
}
export async function bindWorkspacePreparedSnapshot(input) {
    input.signal?.throwIfAborted();
    const paths = resolveWorkspaceIndexingPaths({
        dataDir: input.dataDir,
        workspaceId: input.prepared.scan.workspaceId,
        sessionId: input.sessionId,
        revisionId: input.revisionId,
    });
    await mkdir(paths.sessionCapturesRoot, { recursive: true, mode: 0o700 });
    await chmod(paths.sessionCapturesRoot, 0o700);
    const temporaryDir = path.join(paths.sessionCapturesRoot, `.capture-tmp-${randomUUID()}`);
    const temporaryArchivePath = path.join(temporaryDir, 'workspace.zip');
    const temporaryManifestPath = path.join(temporaryDir, 'manifest.json');
    let published = false;
    await mkdir(temporaryDir, { recursive: false, mode: 0o700 });
    try {
        await link(input.prepared.archivePath, temporaryArchivePath).catch(async () => {
            await copyFile(input.prepared.archivePath, temporaryArchivePath);
        });
        const entries = input.prepared.scan.files.map(toManifestEntry);
        const manifest = {
            schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
            workspaceId: input.prepared.scan.workspaceId,
            sessionId: input.sessionId,
            revisionId: input.revisionId,
            kind: 'initial',
            createdAtMs: input.createdAtMs ?? Date.now(),
            rootHash: input.prepared.scan.rootHash,
            fileCount: entries.length,
            totalBytes: input.prepared.scan.totalBytes,
            entries,
            archive: {
                filename: 'workspace.zip',
                sha256: input.prepared.archiveSha256,
                sizeBytes: input.prepared.archiveSizeBytes,
            },
        };
        await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
            mode: 0o600,
        });
        input.signal?.throwIfAborted();
        await renameWithRetry(temporaryDir, paths.captureDir);
        published = true;
        input.signal?.throwIfAborted();
        return {
            captureDir: paths.captureDir,
            archivePath: paths.archivePath,
            manifestPath: paths.manifestPath,
            archiveSha256: input.prepared.archiveSha256,
            manifest,
            changeSet: {
                added: entries.map((entry) => entry.path),
                modified: [],
                deleted: [],
            },
        };
    }
    catch (error) {
        if (published)
            await rm(paths.captureDir, { recursive: true, force: true });
        await rm(temporaryDir, { recursive: true, force: true });
        throw error;
    }
}
async function renameWithRetry(sourcePath, targetPath, maxRetries = 3) {
    for (let attempt = 0;; attempt += 1) {
        try {
            await rename(sourcePath, targetPath);
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
async function pathExists(targetPath) {
    try {
        await access(targetPath);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        throw error;
    }
}
//# sourceMappingURL=prepared-snapshot.js.map