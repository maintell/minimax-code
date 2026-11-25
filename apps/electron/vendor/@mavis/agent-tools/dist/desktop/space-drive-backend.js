import { homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBatchDeleteResult, parseBatchItemResults, parseDeletePreview, parseDriveNode, parseNodeList, parseNodeWithPath, parsePreparedUpload, requireDownloadUrl, SpaceError, spaceErrorFromHttpStatus, throwIfDriveBusinessFailure, toDriveNumber, } from '../space/index.js';
import { DesktopGatewayHttpError, DesktopMatrixAuthError, } from './matrix-client.js';
/** archon-biz drive routes, the same API the Space page uses, on the managed gateway host. */
export const DESKTOP_SPACE_DRIVE_PREFIX = '/minimax-cloud/api/v1/drive';
/** Classic library download on the same gateway; drive routes reject classic (`cs_`) items. */
export const DESKTOP_LIBRARY_DOWNLOAD_PATH = '/matrix/api/v1/library/download';
const DESKTOP_SPACE_DRIVE_TIMEOUT_MS = 60_000;
/** SpaceDriveBackend over archon-biz HTTP, signed in as the Desktop user. */
export class DesktopSpaceDriveBackend {
    gateway;
    timeoutMs;
    constructor(gateway, timeoutMs = DESKTOP_SPACE_DRIVE_TIMEOUT_MS) {
        this.gateway = gateway;
        this.timeoutMs = timeoutMs;
    }
    async listChildren(params, signal) {
        return parseNodeList(await this.get('folder/children', {
            parent_id: params.parentId,
            parent_path: params.parentPath,
            node_type: params.nodeType,
            order_by: params.orderBy,
            order_desc: params.orderDesc,
            favorite_only: params.favoriteOnly,
            // biz takes the multi-select filters as comma-separated strings; sources are the
            // numeric DriveNodeSource values.
            categories: params.categories?.join(','),
            sources: params.sources?.join(','),
            file_exts: params.fileExts?.join(','),
            offset: params.offset,
            limit: params.limit,
        }, signal));
    }
    async getFile(nodeId, signal) {
        return parseNodeWithPath(await this.get(filePath(nodeId), undefined, signal));
    }
    async getFileByPath(path, signal) {
        return parseNodeWithPath(await this.get('file/by-path', { path }, signal));
    }
    async searchFiles(params, signal) {
        return parseNodeList(await this.get('file', 
        // Legacy (cs_) items are rejected by every drive route; leave them out.
        {
            keyword: params.keyword,
            node_type: params.nodeType,
            limit: params.limit,
            offset: params.offset,
            exclude_legacy: true,
        }, signal));
    }
    async getDownloadUrl(nodeId, signal) {
        return requireDownloadUrl(await this.get(filePath(nodeId, 'download-url'), undefined, signal));
    }
    /**
     * Signed URL of a classic library file, by the numeric id after `cs_`. Desktop only: the
     * Space page downloads classic items through the same library route.
     */
    async getLibraryDownloadUrl(libraryFileId, signal) {
        // Sent as a JSON number like the Space page does, so only ids a double holds exactly pass:
        // a larger one would silently name another file.
        if (!/^\d{1,16}$/u.test(libraryFileId) || !Number.isSafeInteger(Number(libraryFileId))) {
            throw new SpaceError('INVALID_ARGS', 'Invalid classic library file id.');
        }
        const response = await this.request({
            method: 'POST',
            pathname: DESKTOP_LIBRARY_DOWNLOAD_PATH,
            // The gateway takes the classic id as an i64 number, as the Space page sends it.
            body: { library_file_id: Number(libraryFileId) },
            signal,
        });
        // gateway-app answers with top-level fields; tolerate a `data` envelope as well.
        const data = response.data;
        return requireDownloadUrl(data && typeof data === 'object' && !Array.isArray(data)
            ? { ...data, ...response }
            : response);
    }
    async prepareUpload(params, signal) {
        return parsePreparedUpload(await this.post('upload/prepare', { ...params }, signal));
    }
    async commitUpload(params, signal) {
        const response = await this.post('upload/commit', { ...params }, signal);
        return response.node === undefined || response.node === null
            ? undefined
            : parseDriveNode(response.node);
    }
    async createFolder(params, signal) {
        return parseDriveNode((await this.post('folder', { ...params }, signal)).node);
    }
    async moveNode(nodeId, newParentPath, conflictPolicy, signal) {
        await this.post(filePath(nodeId, 'move'), {
            new_parent_id: '',
            new_parent_path: newParentPath,
            ...(conflictPolicy === undefined ? {} : { conflict_policy: conflictPolicy }),
        }, signal);
    }
    async renameNode(nodeId, newName, signal) {
        await this.post(filePath(nodeId, 'rename'), { new_name: newName }, signal);
    }
    async previewDelete(nodeId, signal) {
        return parseDeletePreview(await this.request({ method: 'DELETE', route: filePath(nodeId), query: { dry_run: true }, signal }));
    }
    async deleteNode(nodeId, signal) {
        await this.request({ method: 'DELETE', route: filePath(nodeId), signal });
    }
    async updateFavorite(params, signal) {
        return parseBatchItemResults(await this.post('batch/favorite', { node_ids: params.node_ids, is_favorited: params.favorited }, signal));
    }
    async batchMove(params, signal) {
        return parseBatchItemResults(await this.post('batch/move', {
            node_ids: params.node_ids,
            new_parent_id: params.new_parent_id,
            ...(params.conflict_policy === undefined
                ? {}
                : { conflict_policy: params.conflict_policy }),
        }, signal));
    }
    async batchDelete(params, signal) {
        return parseBatchDeleteResult(await this.post('batch/delete', { node_ids: params.node_ids, dry_run: params.dry_run }, signal));
    }
    async getQuota(signal) {
        const response = await this.get('quota', undefined, signal);
        return {
            used_bytes: toDriveNumber(response.used_bytes) ?? 0,
            quota_bytes: toDriveNumber(response.quota_bytes) ?? 0,
            available_bytes: toDriveNumber(response.available_bytes) ?? 0,
            max_file_bytes: toDriveNumber(response.max_file_bytes) ?? 0,
        };
    }
    get(route, query, signal) {
        return this.request({ method: 'GET', route, ...(query ? { query } : {}), signal });
    }
    post(route, body, signal) {
        return this.request({ method: 'POST', route, body, signal });
    }
    async request(input) {
        let response;
        try {
            response = await this.gateway.requestGatewayJson({
                method: input.method,
                pathname: input.pathname ?? `${DESKTOP_SPACE_DRIVE_PREFIX}/${input.route ?? ''}`,
                ...(input.query ? { query: input.query } : {}),
                ...(input.body ? { body: input.body } : {}),
                ...(input.signal ? { signal: input.signal } : {}),
                timeoutMs: this.timeoutMs,
            });
        }
        catch (error) {
            throw gatewayFailure(error);
        }
        throwIfDriveBusinessFailure(response);
        return response;
    }
}
/**
 * Desktop policy for a model-supplied local path: `~` is the home folder, relative paths start
 * at the workspace. Access outside the workspace is left to the permission engine, which sees
 * the same `local_path`.
 */
export async function resolveDesktopSpaceLocalPath(input, workspaceRoot) {
    let path = input.trim();
    if (!path)
        throw new SpaceError('INVALID_ARGS', 'local_path is empty.');
    if (path.startsWith('file://'))
        path = fileURLToPath(path);
    if (path === '~')
        return homedir();
    if (path.startsWith('~/') || (process.platform === 'win32' && path.startsWith('~\\'))) {
        path = resolvePath(homedir(), path.slice(2));
    }
    return isAbsolute(path) ? resolvePath(path) : resolvePath(workspaceRoot, path);
}
function filePath(nodeId, suffix) {
    const base = `file/${encodeURIComponent(nodeId)}`;
    return suffix ? `${base}/${suffix}` : base;
}
function gatewayFailure(error) {
    if (error instanceof DesktopMatrixAuthError) {
        return new SpaceError('UNAUTHORIZED', 'Not signed in to MiniMax Code. Ask the user to sign in, then retry.');
    }
    if (error instanceof DesktopGatewayHttpError) {
        if (error.statusCode === 401) {
            return new SpaceError('UNAUTHORIZED', 'Authentication failed. Ask the user to sign in to MiniMax Code again, then retry.');
        }
        return spaceErrorFromHttpStatus(error.statusCode, `${httpErrorMessage(error.responsePreview) ?? `HTTP ${error.statusCode}`} (path=${error.pathname})`);
    }
    // Network failures and timeouts: toSpaceError marks them retryable UPSTREAM.
    return error;
}
function httpErrorMessage(text) {
    if (!text.trim())
        return undefined;
    try {
        const body = JSON.parse(text);
        const baseResp = body.base_resp;
        for (const value of [body.error, body.message, baseResp?.status_msg]) {
            if (typeof value === 'string' && value.trim())
                return value.trim();
        }
    }
    catch {
        // Not JSON (a proxy page, a truncated body); fall back to the status.
    }
    return undefined;
}
//# sourceMappingURL=space-drive-backend.js.map