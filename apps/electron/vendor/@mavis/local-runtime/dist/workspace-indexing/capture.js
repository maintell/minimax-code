import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, rmdir, symlink, writeFile, } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { isPathInside } from '../persistence/layout/v2-paths.js';
import { resolveWorkspaceIndexingPaths } from './paths.js';
import { compareWorkspacePaths, toManifestEntry } from './scanner.js';
import { WORKSPACE_MANIFEST_SCHEMA_VERSION, } from './types.js';
import { writeWorkspaceArchive } from './workspace-archive-writer.js';
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
export function diffWorkspaceEntries(previous, current) {
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
export async function restoreWorkspaceCaptures(targetDir, captures) {
    if (captures.length === 0 || captures[0]?.manifest.kind !== 'initial') {
        throw new Error('workspace_restore_requires_initial_capture');
    }
    const requestedTarget = path.resolve(targetDir);
    const requestedParent = path.dirname(requestedTarget);
    if (requestedTarget === requestedParent) {
        throw new Error('workspace_restore_unsafe_target');
    }
    await mkdir(requestedParent, { recursive: true, mode: 0o700 });
    const parentRoot = await realpath(requestedParent);
    const targetRoot = path.join(parentRoot, path.basename(requestedTarget));
    const existing = await lstat(targetRoot).catch((error) => {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    });
    if (existing) {
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
            throw new Error('workspace_restore_unsafe_target');
        }
        if ((await readdir(targetRoot)).length > 0) {
            throw new Error('workspace_restore_target_not_empty');
        }
    }
    const stagingRoot = await mkdtemp(path.join(parentRoot, `.${path.basename(targetRoot)}.workspace-restore-`));
    await chmod(stagingRoot, 0o700);
    try {
        await restoreCaptureChain(stagingRoot, captures);
        if (existing)
            await rmdir(targetRoot);
        await renameWithRetry(stagingRoot, targetRoot, rename);
    }
    catch (error) {
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
    }
}
async function restoreCaptureChain(targetRoot, captures) {
    let previous;
    for (const capture of captures) {
        validateRestoreChain(previous, capture.manifest);
        const archive = await readFile(capture.archivePath);
        if (sha256(archive) !== capture.manifest.archive.sha256) {
            throw new Error(`workspace_archive_hash_mismatch:${capture.manifest.revisionId}`);
        }
        const currentPaths = new Set(capture.manifest.entries.map((entry) => entry.path));
        for (const oldEntry of previous?.entries ?? []) {
            if (!currentPaths.has(oldEntry.path)) {
                await rm(resolveRestorePath(targetRoot, oldEntry.path), { recursive: true, force: true });
            }
        }
        await extractWorkspaceArchive(targetRoot, archive);
        await restoreSymlinks(targetRoot, capture.manifest.entries);
        await verifyRestoredEntries(targetRoot, capture.manifest.entries);
        previous = capture.manifest;
    }
}
async function extractWorkspaceArchive(targetRoot, archive) {
    const zip = await JSZip.loadAsync(archive);
    const names = Object.keys(zip.files).sort(compareWorkspacePaths);
    for (const name of names) {
        const entry = zip.files[name];
        if (!entry) {
            throw new Error('workspace_capture_archive_entry_missing');
        }
        const targetPath = resolveRestorePath(targetRoot, name.replace(/\/$/u, ''));
        if (entry.dir) {
            await mkdir(targetPath, { recursive: true, mode: 0o700 });
            continue;
        }
        await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        await rm(targetPath, { recursive: true, force: true });
        await writeFile(targetPath, await entry.async('nodebuffer'), {
            mode: normalizeFileMode(entry.unixPermissions),
        });
    }
}
async function restoreSymlinks(targetRoot, entries) {
    for (const entry of entries) {
        if (entry.kind !== 'symlink')
            continue;
        const targetPath = resolveRestorePath(targetRoot, entry.path);
        const resolvedLinkTarget = path.resolve(path.dirname(targetPath), entry.linkTarget);
        if (!isPathInside(targetRoot, resolvedLinkTarget)) {
            throw new Error(`workspace_symlink_escapes_restore_root:${entry.path}`);
        }
        await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
        await rm(targetPath, { recursive: true, force: true });
        await symlink(entry.linkTarget, targetPath);
    }
}
async function verifyRestoredEntries(targetRoot, entries) {
    for (const entry of entries) {
        const targetPath = resolveRestorePath(targetRoot, entry.path);
        const actual = entry.kind === 'file'
            ? sha256(await readFile(targetPath))
            : sha256(Buffer.from(`symlink\0${await readlink(targetPath)}`, 'utf8'));
        if (actual !== entry.sha256) {
            throw new Error(`workspace_restored_hash_mismatch:${entry.path}`);
        }
    }
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
function validateRestoreChain(previous, current) {
    if (!previous) {
        if (current.kind !== 'initial')
            throw new Error('workspace_restore_chain_missing_initial');
        return;
    }
    if (current.kind !== 'revision' ||
        current.workspaceId !== previous.workspaceId ||
        current.sessionId !== previous.sessionId ||
        current.baseRevisionId !== previous.revisionId ||
        current.baseRootHash !== previous.rootHash) {
        throw new Error(`workspace_restore_chain_mismatch:${current.revisionId}`);
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
function resolveRestorePath(targetRoot, relativePath) {
    if (!relativePath ||
        path.posix.isAbsolute(relativePath) ||
        relativePath.includes('\\') ||
        path.posix.normalize(relativePath) !== relativePath) {
        throw new Error(`workspace_restore_unsafe_path:${relativePath}`);
    }
    const resolved = path.resolve(targetRoot, ...relativePath.split('/'));
    if (!isPathInside(targetRoot, resolved)) {
        throw new Error(`workspace_restore_path_escape:${relativePath}`);
    }
    return resolved;
}
function normalizeFileMode(mode) {
    if (typeof mode === 'number')
        return mode & 0o777;
    if (typeof mode === 'string') {
        const parsed = Number.parseInt(mode, 8);
        if (Number.isFinite(parsed))
            return parsed & 0o777;
    }
    return 0o600;
}
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
//# sourceMappingURL=capture.js.map