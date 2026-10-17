import path from 'node:path';
import { resolveV2DirectoryContract, sanitizeV2PathSegment, } from '../persistence/layout/v2-paths.js';
export function resolveWorkspaceIndexingPaths(input) {
    const root = resolveV2DirectoryContract(input.dataDir).workspaces;
    const workspaceId = sanitizeV2PathSegment(input.workspaceId, 'workspace');
    const sessionId = sanitizeV2PathSegment(input.sessionId, 'session');
    const revisionId = sanitizeV2PathSegment(input.revisionId, 'revision');
    const workspaceRoot = path.join(root, workspaceId);
    const capturesRoot = path.join(workspaceRoot, 'captures');
    const sessionCapturesRoot = path.join(capturesRoot, sessionId);
    const captureDir = path.join(sessionCapturesRoot, revisionId);
    const indexesRoot = path.join(workspaceRoot, 'indexes');
    const revisionIndexRoot = path.join(indexesRoot, revisionId);
    return {
        root,
        workspaceRoot,
        capturesRoot,
        sessionCapturesRoot,
        captureDir,
        archivePath: path.join(captureDir, 'workspace.zip'),
        manifestPath: path.join(captureDir, 'manifest.json'),
        indexesRoot,
        revisionIndexRoot,
        semanticIndexPath: path.join(revisionIndexRoot, 'semantic-index.zip'),
        semanticIndexMetadataPath: path.join(revisionIndexRoot, 'metadata.json'),
        currentPointerPath: path.join(workspaceRoot, 'current.json'),
    };
}
export function resolveWorkspacePrewarmPaths(input) {
    const root = resolveV2DirectoryContract(input.dataDir).workspaces;
    const workspaceId = sanitizeV2PathSegment(input.workspaceId, 'workspace');
    const workspaceRoot = path.join(root, workspaceId);
    const prewarmRoot = path.join(workspaceRoot, 'prewarm');
    const preparedDir = path.join(prewarmRoot, 'current');
    return {
        root,
        workspaceRoot,
        prewarmRoot,
        preparedDir,
        archivePath: path.join(preparedDir, 'workspace.zip'),
        metadataPath: path.join(preparedDir, 'snapshot.json'),
    };
}
//# sourceMappingURL=paths.js.map