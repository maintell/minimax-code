import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
/** @internal Exported only for focused path-boundary tests. */
export function resolveArtifactPath(workspace, file, platform = process.platform) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (!workspace || !paths.isAbsolute(workspace) || !file || /^(https?:|data:|drive:)/iu.test(file))
        return { path: file, allowed: false };
    const resolved = paths.resolve(workspace, file);
    const relative = paths.relative(workspace, resolved);
    const allowed = relative !== '' &&
        !paths.isAbsolute(relative) &&
        relative !== '..' &&
        !relative.startsWith(`..${paths.sep}`);
    return { path: resolved, allowed };
}
async function fileStatus(workspace, file) {
    try {
        const [root, resolved] = await Promise.all([realpath(workspace), realpath(file)]);
        if (!resolveArtifactPath(root, resolved).allowed)
            return 'unavailable';
        return (await stat(resolved)).isFile() ? 'available' : 'unavailable';
    }
    catch (error) {
        return error.code === 'ENOENT' ||
            error.code === 'ENOTDIR'
            ? 'missing'
            : 'unavailable';
    }
}
export function artifactId(sessionId, assetKey) {
    return Buffer.from(JSON.stringify([sessionId, assetKey])).toString('base64url');
}
export async function artifactView(row) {
    // Explicit Bunny deliveries may reference a single file outside the session workspace.
    const workspaceDir = row.externalDelivery && path.isAbsolute(row.path)
        ? path.dirname(row.path)
        : (row.workspaceDir ?? '');
    const target = resolveArtifactPath(workspaceDir, row.path);
    return {
        id: artifactId(row.sessionId, row.assetKey),
        name: row.name,
        path: target.path,
        extension: path.extname(target.path).slice(1).toLowerCase(),
        category: row.category,
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle ?? '',
        sessionArchived: row.sessionArchived === 1,
        workspaceDir,
        messageId: row.messageId,
        deliveredAtMs: row.deliveredAtMs,
        fileStatus: target.allowed ? await fileStatus(workspaceDir, target.path) : 'unavailable',
        ...(row.spaceId ? { spaceId: row.spaceId } : {}),
        origin: row.origin,
        sourceAvailable: row.sourceAvailable === 1,
        updatedAtMs: row.updatedAtMs,
    };
}
//# sourceMappingURL=paths.js.map