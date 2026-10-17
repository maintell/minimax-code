/**
 * `mavis drive ...` 命令组 —— 8 个 handler:
 *   - files.list / get / delete / search / download / upload
 *   - nodes.move / rename
 *
 * `quota.get` 和 `websites.create` 已下线(不再暴露给 LLM),代码不再保留。
 *
 * `drive files upload` 走 upload.ts 的三步原子流程(prepare → PUT OSS → commit),
 * 在 tool 内吞 OSS 直传,LLM 看不到中间的 presigned URL。其余 handler 都是 thin
 * wrapper 调 callRpc。
 */
import { DriveNodeSource, DriveNodeType, } from '../../runtime-types.js';
import { failure, success } from '../output.js';
import { DofldUploadError, uploadFileFlow } from '../upload.js';
const DRIVE_BUSINESS_FAILED = 'DRIVE_BUSINESS_FAILED';
const DRIVE_DOWNLOAD_URL_MISSING = 'DRIVE_DOWNLOAD_URL_MISSING';
const DRIVE_NODE_NOT_FOUND = 'DRIVE_NODE_NOT_FOUND';
function driveResponse(command, response, path) {
    const statusCode = response.base_resp?.status_code;
    if (statusCode !== undefined && statusCode !== 0) {
        return failure(command, 'archon_server', 'DRIVE_BUSINESS_FAILED: Drive request was rejected.', {
            error_code: DRIVE_BUSINESS_FAILED,
            status_code: statusCode,
            path,
        });
    }
    const payload = { ...response };
    delete payload.base_resp;
    return success(command, payload);
}
function driveDownloadResponse(command, response, nodeId, path) {
    const output = driveResponse(command, response, path);
    if (!output.ok)
        return output;
    if (response.download_url)
        return output;
    return failure(command, 'archon_server', 'DRIVE_DOWNLOAD_URL_MISSING: Drive response did not include download_url.', { error_code: DRIVE_DOWNLOAD_URL_MISSING, node_id: nodeId, path });
}
export const handleDriveFilesList = async (ctx, args, signal) => {
    const nodeType = args.node_type
        ? DriveNodeType[args.node_type]
        : undefined;
    const resp = await ctx.archonServer.callRpc('ListFiles', {
        ...(args.parent_id !== undefined ? { parent_id: args.parent_id } : {}),
        ...(nodeType !== undefined ? { node_type: nodeType } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }, signal);
    return driveResponse(ctx.command, resp, '/api/v1/drive/files/list');
};
export const handleDriveFilesGet = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('GetFile', { node_id: args.node_id }, signal);
    const output = driveResponse(ctx.command, resp, '/api/v1/drive/files/get');
    if (!output.ok)
        return output;
    if (!resp.node) {
        return failure(ctx.command, 'archon_server', 'DRIVE_NODE_NOT_FOUND: Drive node was not found.', {
            error_code: DRIVE_NODE_NOT_FOUND,
            node_id: args.node_id,
            path: '/api/v1/drive/files/get',
        });
    }
    return output;
};
export const handleDriveFilesDelete = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('DeleteFile', { node_id: args.node_id }, signal);
    return driveResponse(ctx.command, resp, '/api/v1/drive/files/delete');
};
export const handleDriveFilesSearch = async (ctx, args, signal) => {
    const source = args.source
        ? DriveNodeSource[args.source]
        : undefined;
    const resp = await ctx.archonServer.callRpc('SearchFiles', {
        ...(args.keyword !== undefined ? { keyword: args.keyword } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(source !== undefined ? { source } : {}),
        ...(args.session_id !== undefined ? { session_id: args.session_id } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        ...(args.is_favorited !== undefined ? { is_favorited: args.is_favorited } : {}),
    }, signal);
    return driveResponse(ctx.command, resp, '/api/v1/drive/files/search');
};
export const handleDriveFilesDownload = async (ctx, args, signal) => {
    // Prefer GetRawDownloadURL so the agent reread path returns the raw
    // (un-watermarked, original) asset bytes — what the agent saw when
    // it generated the deliverable. Public web / mobile surfaces use
    // GetDownloadURL (labeled / watermarked variant) instead.
    //
    // archon-server `feat/aigc-labeled-mirror` ships the new endpoint;
    // on a deployment where it hasn't landed yet (404 / 405 / "not
    // found" Hertz response) we transparently fall back to
    // GetDownloadURL so this CLI remains usable across the rollout.
    // Network / 5xx errors are NOT fall-back-eligible — they would
    // mask a real archon-server problem behind a successful labeled
    // URL and surprise the user with the wrong bytes.
    try {
        const resp = await ctx.archonServer.callRpc('GetRawDownloadURL', { node_id: args.node_id }, signal);
        return driveDownloadResponse(ctx.command, resp, args.node_id, '/api/v1/drive/files/raw-download-url');
    }
    catch (err) {
        if (isArchonEndpointNotFound(err)) {
            // Endpoint not deployed yet — fall back to the labeled variant.
            // Log only the stable code and numeric HTTP status; endpoint errors can
            // contain request/auth details and must not enter the tool/event path.
            console.warn(`[mavis:drive] stage=raw_download_fallback code=DRIVE_RAW_DOWNLOAD_FALLBACK http_status=${httpStatusFromError(err) ?? 'none'}`);
            const resp = await ctx.archonServer.callRpc('GetDownloadURL', { node_id: args.node_id }, signal);
            return driveDownloadResponse(ctx.command, resp, args.node_id, '/api/v1/drive/files/download-url');
        }
        throw err;
    }
};
/**
 * Heuristic for "this archon-server doesn't know that endpoint yet".
 * Matches the upstream `RemoteArchonServerError` message shape from
 * `packages/cloud-runtime/src/adapters/server/remote.ts` which embeds
 * `HTTP <status>` and the response body in the error message.
 *
 * Treat 404 and 405 (method not allowed — Hertz returns this when
 * the path is unregistered) as "fall back". Network errors / 5xx
 * are intentionally NOT fall-back-eligible — those represent a live
 * archon-server problem, not a missing endpoint.
 */
function isArchonEndpointNotFound(err) {
    const httpStatus = httpStatusFromError(err);
    return httpStatus === 404 || httpStatus === 405;
}
function httpStatusFromError(error) {
    if (!(error instanceof Error))
        return undefined;
    const match = /\bHTTP\s+(\d{3})\b/i.exec(error.message);
    return match ? Number(match[1]) : undefined;
}
export const handleDriveFilesUpload = async (ctx, args, signal) => {
    try {
        const commit = await uploadFileFlow({ archonServer: ctx.archonServer, workspaceRoot: ctx.workspaceRoot }, args, signal);
        return success(ctx.command, commit);
    }
    catch (error) {
        if (error instanceof DofldUploadError) {
            return failure(ctx.command, error.kind, error.message, error.extra);
        }
        throw error;
    }
};
export const handleDriveNodesMove = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('MoveNode', { node_id: args.node_id, new_parent_id: args.new_parent_id }, signal);
    return driveResponse(ctx.command, resp, '/api/v1/drive/nodes/move');
};
export const handleDriveNodesRename = async (ctx, args, signal) => {
    const resp = await ctx.archonServer.callRpc('RenameNode', { node_id: args.node_id, new_name: args.new_name }, signal);
    return driveResponse(ctx.command, resp, '/api/v1/drive/nodes/rename');
};
//# sourceMappingURL=drive.js.map