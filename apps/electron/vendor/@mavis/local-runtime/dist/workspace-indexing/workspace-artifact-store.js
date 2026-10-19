import { createHash } from 'node:crypto';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { resolveWorkspaceIndexingPaths } from './paths.js';
export async function deleteLocalWorkspaceArtifacts(dataDir, semanticIndexStore, session, revisions) {
    const paths = resolveWorkspaceIndexingPaths({
        dataDir,
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        revisionId: revisions[0]?.revisionId ?? 'none',
    });
    await semanticIndexStore.deleteRevisions({
        workspaceId: session.workspaceId,
        revisionIds: revisions.map((revision) => revision.revisionId),
    });
    await rm(paths.sessionCapturesRoot, { recursive: true, force: true });
    await pruneEmptyDirectory(paths.capturesRoot);
    await pruneEmptyDirectory(paths.indexesRoot);
    await pruneEmptyDirectory(paths.workspaceRoot);
}
export async function toWorkspaceIndexingRevisionRecord(artifact, sequence, nowMs) {
    return {
        revisionId: artifact.manifest.revisionId,
        sessionId: artifact.manifest.sessionId,
        workspaceId: artifact.manifest.workspaceId,
        sequence,
        kind: artifact.manifest.kind,
        rootHash: artifact.manifest.rootHash,
        ...(artifact.manifest.baseRevisionId
            ? { baseRevisionId: artifact.manifest.baseRevisionId }
            : {}),
        ...(artifact.manifest.baseRootHash ? { baseRootHash: artifact.manifest.baseRootHash } : {}),
        archivePath: artifact.archivePath,
        manifestPath: artifact.manifestPath,
        archiveSha256: artifact.archiveSha256,
        manifestSha256: sha256(await readFile(artifact.manifestPath)),
        remoteState: 'pending_upload',
        retryCount: 0,
        nextRetryAtMs: nowMs,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
    };
}
export async function readWorkspaceCaptureManifest(manifestPath) {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
}
async function pruneEmptyDirectory(directory) {
    try {
        await rmdir(directory);
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST')
            throw error;
    }
}
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
//# sourceMappingURL=workspace-artifact-store.js.map