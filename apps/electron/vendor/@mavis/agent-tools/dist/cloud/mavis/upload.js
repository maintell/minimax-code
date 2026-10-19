/**
 * `mavis drive files upload` 的原子三步实现 ——
 *   1) UploadPrepare → 拿 OSS presigned PUT URL + content_type
 *   2) raw PUT bytes 到 OSS(echo content_type 否则验签 403)
 *   3) UploadCommit → 把 Pending node 升级 Active,扣配额,拿完整 DriveNode
 *
 * 二进制内容来源二选一:
 *   - `local_path` —— workspace-relative,sandbox 内已经写好的文件
 *   - `content_base64` —— base64 字节(小文件兜底)
 *
 * 失败时抛 typed Error,DofldTool 上层 wrap 为 `{ kind: "oss_upload" | "workspace" | "archon_server" }`。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DriveNodeSource } from '../runtime-types.js';
import { resolveWithinWorkspace } from '../path-guard.js';
export class DofldUploadError extends Error {
    kind;
    extra;
    constructor(message, kind, extra = {}) {
        super(message);
        this.kind = kind;
        this.extra = extra;
        this.name = 'DofldUploadError';
    }
}
export async function uploadFileFlow(deps, args, signal) {
    const bytes = await readSourceBytes(deps.workspaceRoot, args);
    const prepare = await deps.archonServer.callRpc('UploadPrepare', {
        file_name: args.file_name,
        ...(args.parent_path ? { parent_path: args.parent_path } : {}),
        ...(args.source ? { source: DriveNodeSource[args.source] } : {}),
        ...(args.session_id ? { session_id: args.session_id } : {}),
        ...(args.agent_name ? { agent_name: args.agent_name } : {}),
    }, signal);
    if (!prepare.node_id || !prepare.upload_url) {
        throw new DofldUploadError(prepare.base_resp?.status_msg ?? 'archon-server UploadPrepare returned no upload_url', 'archon_server', { status_code: prepare.base_resp?.status_code, prepare });
    }
    const headers = {};
    if (prepare.content_type)
        headers['Content-Type'] = prepare.content_type;
    let putResponse;
    try {
        putResponse = await fetch(prepare.upload_url, {
            method: 'PUT',
            headers,
            // Avoid passing Node's Buffer<ArrayBufferLike> directly to the DOM
            // fetch type; a plain Uint8Array is accepted by both Node and browsers.
            body: new Uint8Array(bytes),
            signal,
        });
    }
    catch (error) {
        const message = error instanceof Error && error.name === 'AbortError'
            ? 'upload aborted'
            : error instanceof Error
                ? error.message
                : String(error);
        throw new DofldUploadError(`OSS PUT failed: ${message}`, 'oss_upload', {
            node_id: prepare.node_id,
        });
    }
    if (!putResponse.ok) {
        const responseText = await safeReadText(putResponse);
        throw new DofldUploadError(`OSS PUT failed: HTTP ${putResponse.status}`, 'oss_upload', {
            node_id: prepare.node_id,
            status: putResponse.status,
            body: responseText.slice(0, 1024),
        });
    }
    const commit = await deps.archonServer.callRpc('UploadCommit', {
        node_id: prepare.node_id,
        size_bytes: bytes.byteLength,
        checksum: createHash('md5').update(bytes).digest('hex'),
    }, signal);
    if (commit.base_resp && commit.base_resp.status_code !== 0) {
        throw new DofldUploadError(commit.base_resp.status_msg ?? 'archon-server UploadCommit returned non-zero status', 'archon_server', { status_code: commit.base_resp.status_code, node_id: prepare.node_id });
    }
    return commit;
}
async function readSourceBytes(workspaceRoot, args) {
    if (args.local_path) {
        let absPath;
        try {
            absPath = await resolveWithinWorkspace(args.local_path, workspaceRoot);
        }
        catch (error) {
            throw new DofldUploadError(error instanceof Error ? error.message : String(error), 'workspace', { local_path: args.local_path });
        }
        try {
            return await readFile(absPath);
        }
        catch (error) {
            throw new DofldUploadError(error instanceof Error ? error.message : String(error), 'workspace', { local_path: args.local_path });
        }
    }
    if (args.content_base64) {
        try {
            return Buffer.from(args.content_base64, 'base64');
        }
        catch (error) {
            throw new DofldUploadError(error instanceof Error ? error.message : 'invalid base64', 'workspace');
        }
    }
    // schema 已禁止双空,理论不可达;留 fail-safe。
    throw new DofldUploadError('Missing both local_path and content_base64', 'workspace');
}
async function safeReadText(response) {
    try {
        return await response.text();
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=upload.js.map