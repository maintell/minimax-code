import { parseBatchDeleteResult, parseBatchItemResults, parseDeletePreview, parseDriveNode, parseNodeList, parseNodeWithPath, parsePreparedUpload, requireDownloadUrl, SpaceError, spaceErrorFromHttpStatus, throwIfDriveBusinessFailure, toDriveNumber, } from '../space/index.js';
import { resolveWithinWorkspace } from './path-guard.js';
import { DriveNodeSource } from './runtime-types.js';
const HTTP_STATUS_IN_MESSAGE = /\bHTTP\s+(\d{3})\b/iu;
/** SpaceDriveBackend over archon-server RPC, as the user the harness is bound to. */
export class CloudSpaceDriveBackend {
    server;
    postObject;
    constructor(server, options = {}) {
        this.server = server;
        this.postObject = options.postObject ?? true;
    }
    async listChildren(params, signal) {
        return parseNodeList(await this.call('ListFiles', {
            parent_id: params.parentId,
            parent_path: params.parentPath,
            node_type: params.nodeType,
            order_by: params.orderBy,
            order_desc: params.orderDesc,
            favorite_only: params.favoriteOnly,
            categories: params.categories,
            sources: params.sources,
            file_exts: params.fileExts,
            offset: params.offset,
            limit: params.limit,
            // Files delivered by sessions live in Space too.
            include_session_files: true,
        }, signal));
    }
    async getFile(nodeId, signal) {
        return parseNodeWithPath(await this.call('GetFile', { node_id: nodeId }, signal));
    }
    async getFileByPath(path, signal) {
        return parseNodeWithPath(await this.call('GetFile', { node_id: '', path }, signal));
    }
    async searchFiles(params, signal) {
        return parseNodeList(await this.call('SearchFiles', 
        // Legacy (cs_) items are rejected by every drive route; leave them out.
        {
            keyword: params.keyword,
            node_type: params.nodeType,
            offset: params.offset,
            limit: params.limit,
            exclude_legacy: true,
        }, signal));
    }
    async getDownloadUrl(nodeId, signal) {
        return requireDownloadUrl(await this.call('GetDownloadURL', { node_id: nodeId }, signal));
    }
    async prepareUpload(params, signal) {
        return parsePreparedUpload(await this.call('UploadPrepare', { ...params, post_object: this.postObject, source: DriveNodeSource.UserUpload }, signal));
    }
    async commitUpload(params, signal) {
        const response = await this.call('UploadCommit', { ...params }, signal);
        return response.node === undefined || response.node === null
            ? undefined
            : parseDriveNode(response.node);
    }
    async createFolder(params, signal) {
        return parseDriveNode((await this.call('CreateFolder', { ...params }, signal)).node);
    }
    async moveNode(nodeId, newParentPath, conflictPolicy, signal) {
        await this.call('MoveNode', {
            node_id: nodeId,
            new_parent_id: '',
            new_parent_path: newParentPath,
            ...(conflictPolicy === undefined ? {} : { conflict_policy: conflictPolicy }),
        }, signal);
    }
    async renameNode(nodeId, newName, signal) {
        await this.call('RenameNode', { node_id: nodeId, new_name: newName }, signal);
    }
    async previewDelete(nodeId, signal) {
        return parseDeletePreview(await this.call('DeleteFile', { node_id: nodeId, dry_run: true }, signal));
    }
    async deleteNode(nodeId, signal) {
        await this.call('DeleteFile', { node_id: nodeId }, signal);
    }
    async updateFavorite(params, signal) {
        return parseBatchItemResults(await this.call('BatchUpdateFavorite', { node_ids: params.node_ids, is_favorited: params.favorited }, signal));
    }
    async batchMove(params, signal) {
        return parseBatchItemResults(await this.call('BatchMoveNodes', {
            node_ids: params.node_ids,
            new_parent_id: params.new_parent_id,
            ...(params.conflict_policy === undefined
                ? {}
                : { conflict_policy: params.conflict_policy }),
        }, signal));
    }
    async batchDelete(params, signal) {
        return parseBatchDeleteResult(await this.call('BatchDeleteFiles', { node_ids: params.node_ids, dry_run: params.dry_run }, signal));
    }
    async getQuota(signal) {
        const response = await this.call('GetUserQuota', {}, signal);
        const quota = (response.quota ?? {});
        return {
            used_bytes: toDriveNumber(quota.used_bytes) ?? 0,
            quota_bytes: toDriveNumber(quota.quota_bytes) ?? 0,
            available_bytes: toDriveNumber(response.available_bytes) ?? 0,
            max_file_bytes: toDriveNumber(response.max_file_bytes) ?? 0,
        };
    }
    async call(rpc, request, signal) {
        let response;
        try {
            response = (await this.server.callRpc(rpc, request, signal));
        }
        catch (error) {
            throw rpcFailure(error);
        }
        throwIfDriveBusinessFailure(response);
        return response;
    }
}
/** The adapter reports HTTP failures in the message and already retried transient ones. */
function rpcFailure(error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = HTTP_STATUS_IN_MESSAGE.exec(message)?.[1];
    if (status)
        return spaceErrorFromHttpStatus(Number(status), message);
    return new SpaceError('UPSTREAM', message, error?.retryable === true);
}
/** Cloud policy for a model-supplied local path: inside the workspace, like read and write. */
export async function resolveCloudSpaceLocalPath(input, workspaceRoot) {
    const path = input.trim();
    if (!path)
        throw new SpaceError('INVALID_ARGS', 'local_path is empty.');
    try {
        return await resolveWithinWorkspace(path, workspaceRoot);
    }
    catch {
        throw new SpaceError('INVALID_ARGS', `local_path must be inside the working directory: ${path}`);
    }
}
//# sourceMappingURL=space-drive-backend.js.map