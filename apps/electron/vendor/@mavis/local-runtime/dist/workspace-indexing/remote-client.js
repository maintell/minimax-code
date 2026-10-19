import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LocalMatrixClient } from '../matrix/local-matrix-client.js';
import { WORKSPACE_MANIFEST_SCHEMA_VERSION, WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION, } from './types.js';
import { MAX_WORKSPACE_SEMANTIC_INDEX_ARCHIVE_BYTES } from './semantic-index-store.js';
const WORKSPACE_INDEXING_GATEWAY_PREFIX = '/mavis/api/v1/mcp/workspace-indexing';
const GET_UPLOAD_URL_PATH = `${WORKSPACE_INDEXING_GATEWAY_PREFIX}/uploads/presign`;
const REGISTER_REVISION_PATH = `${WORKSPACE_INDEXING_GATEWAY_PREFIX}/revisions/register`;
const REVISION_STATUS_PATH = `${WORKSPACE_INDEXING_GATEWAY_PREFIX}/revisions/status`;
const QUERY_EMBEDDING_PATH = `${WORKSPACE_INDEXING_GATEWAY_PREFIX}/query-embedding`;
const DEFAULT_REMOTE_TIMEOUT_MS = 120_000;
const DEFAULT_UPLOAD_TIMEOUT_MS = 1_500_000;
export class LocalWorkspaceIndexingRemoteClient {
    getGateway;
    constructor(options = {}) {
        const injectedGateway = options.gateway;
        if (injectedGateway) {
            this.getGateway = () => injectedGateway;
            return;
        }
        const dynamicAuthContext = options.authContextGetter
            ? {
                get accessToken() {
                    return options.authContextGetter?.()?.accessToken;
                },
            }
            : options.authContext;
        let gateway;
        this.getGateway = () => {
            gateway ??= new LocalMatrixClient({
                ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
                ...(dynamicAuthContext ? { authContext: dynamicAuthContext } : {}),
                ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
                routingContextGetter: options.routingContextGetter,
            });
            return gateway;
        };
    }
    async uploadFile(input) {
        const file = await stat(input.localPath);
        if (!file.isFile())
            throw remoteError('workspace_upload_not_file');
        const response = await this.getGateway().postGatewayJson(GET_UPLOAD_URL_PATH, {
            filename: input.filename,
            mime_type: input.mimeType,
            size_bytes: file.size,
            category: input.category,
            session_id: input.sessionId,
            revision_id: input.revisionId,
        }, input.signal, DEFAULT_UPLOAD_TIMEOUT_MS);
        assertSuccess(response, 'workspace_get_upload_url_failed');
        const putUrl = readRequiredString(response, 'put_url');
        const ossKey = readRequiredString(response, 'oss_key');
        const contentType = typeof response.content_type === 'string' && response.content_type.trim()
            ? response.content_type
            : input.mimeType;
        const body = Readable.toWeb(createReadStream(input.localPath));
        await this.getGateway().putBytes(putUrl, body, {
            'Content-Type': contentType,
        }, input.signal, DEFAULT_UPLOAD_TIMEOUT_MS);
        return ossKey;
    }
    async registerRevision(record, signal) {
        if (!record.archiveOssKey || !record.manifestOssKey) {
            throw remoteError('workspace_revision_oss_keys_missing');
        }
        const response = await this.getGateway().postGatewayJson(REGISTER_REVISION_PATH, {
            manifest_schema_version: WORKSPACE_MANIFEST_SCHEMA_VERSION,
            semantic_index_schema_version: WORKSPACE_SEMANTIC_INDEX_SCHEMA_VERSION,
            workspace_id: record.workspaceId,
            session_id: record.sessionId,
            revision_id: record.revisionId,
            sequence: record.sequence,
            kind: record.kind,
            root_hash: record.rootHash,
            ...(record.baseRevisionId ? { base_revision_id: record.baseRevisionId } : {}),
            ...(record.baseRootHash ? { base_root_hash: record.baseRootHash } : {}),
            archive_oss_key: record.archiveOssKey,
            archive_sha256: record.archiveSha256,
            manifest_oss_key: record.manifestOssKey,
            manifest_sha256: record.manifestSha256,
        }, signal, DEFAULT_REMOTE_TIMEOUT_MS);
        assertSuccess(response, 'workspace_register_revision_failed');
    }
    async getRevisionStatus(input) {
        const response = await this.getGateway().postGatewayJson(REVISION_STATUS_PATH, {
            workspace_id: input.workspaceId,
            session_id: input.sessionId,
            revision_id: input.revisionId,
            root_hash: input.rootHash,
        }, input.signal, DEFAULT_REMOTE_TIMEOUT_MS);
        assertSuccess(response, 'workspace_revision_status_failed');
        const status = readRequiredString(response, 'status').toLowerCase();
        if (status === 'pending' || status === 'processing' || status === 'indexing') {
            return { status: status === 'pending' ? 'pending' : 'processing' };
        }
        if (status === 'failed') {
            return {
                status: 'failed',
                errorCode: readOptionalString(response, 'error_code') ?? 'workspace_embedding_failed',
                retryable: response.retryable !== false,
            };
        }
        if (status !== 'ready')
            throw remoteError('workspace_revision_status_invalid');
        const dimensions = readRequiredPositiveInteger(response, 'dimensions');
        const sizeBytes = readRequiredPositiveInteger(response, 'index_size_bytes');
        const normalization = readRequiredString(response, 'normalization');
        if (normalization !== 'l2')
            throw remoteError('workspace_index_normalization_invalid');
        const sha256 = readRequiredString(response, 'index_sha256');
        if (!/^[a-f0-9]{64}$/u.test(sha256))
            throw remoteError('workspace_index_hash_invalid');
        return {
            status: 'ready',
            downloadUrl: readRequiredString(response, 'index_download_url'),
            sha256,
            sizeBytes,
            embeddingModel: readRequiredString(response, 'embedding_model'),
            dimensions,
            normalization,
        };
    }
    async downloadIndex(input) {
        if (!Number.isInteger(input.expectedSizeBytes) ||
            input.expectedSizeBytes <= 0 ||
            input.expectedSizeBytes > MAX_WORKSPACE_SEMANTIC_INDEX_ARCHIVE_BYTES) {
            throw remoteError('workspace_index_download_size_invalid');
        }
        const response = await this.getGateway().getStream(input.url, input.signal, DEFAULT_UPLOAD_TIMEOUT_MS);
        try {
            if (response.contentLength !== undefined &&
                response.contentLength !== input.expectedSizeBytes) {
                throw remoteError('workspace_index_download_size_mismatch');
            }
            let total = 0;
            const hash = createHash('sha256');
            const meter = new Transform({
                transform(chunk, _encoding, callback) {
                    total += chunk.byteLength;
                    if (total > input.expectedSizeBytes ||
                        total > MAX_WORKSPACE_SEMANTIC_INDEX_ARCHIVE_BYTES) {
                        callback(remoteError('workspace_index_download_size_mismatch'));
                        return;
                    }
                    hash.update(chunk);
                    callback(null, chunk);
                },
            });
            await pipeline(
            // Bridge the DOM stream declaration to node:stream/web without
            // changing the underlying stream or its cancellation behavior.
            Readable.fromWeb(response.body), meter, createWriteStream(input.targetPath, { flags: 'wx', mode: 0o600 }), ...(input.signal ? [{ signal: input.signal }] : []));
            if (total !== input.expectedSizeBytes) {
                throw remoteError('workspace_index_download_size_mismatch');
            }
            return {
                path: input.targetPath,
                sizeBytes: total,
                sha256: hash.digest('hex'),
            };
        }
        catch (error) {
            await rm(input.targetPath, { force: true });
            throw error;
        }
        finally {
            response.dispose();
        }
    }
    async embedQuery(input) {
        const response = await this.getGateway().postGatewayJson(QUERY_EMBEDDING_PATH, {
            workspace_id: input.workspaceId,
            revision_id: input.revisionId,
            query: input.query,
            embedding_model: input.embeddingModel,
            dimensions: input.dimensions,
            normalization: input.normalization,
        }, input.signal, DEFAULT_REMOTE_TIMEOUT_MS);
        assertSuccess(response, 'workspace_query_embedding_failed');
        const vector = response.vector;
        if (!Array.isArray(vector) ||
            vector.length !== input.dimensions ||
            vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
            throw remoteError('workspace_query_embedding_invalid');
        }
        return vector;
    }
}
function assertSuccess(response, fallbackCode) {
    const baseResp = response.base_resp && typeof response.base_resp === 'object'
        ? response.base_resp
        : undefined;
    const code = typeof baseResp?.status_code === 'number'
        ? baseResp.status_code
        : typeof response.code === 'number'
            ? response.code
            : 0;
    if (code !== 0) {
        const serverCode = readOptionalString(response, 'error_code') ??
            readOptionalString(response, 'code_name') ??
            fallbackCode;
        throw remoteError(serverCode);
    }
}
function readRequiredString(response, key) {
    const value = readOptionalString(response, key);
    if (!value)
        throw remoteError(`workspace_response_missing_${key}`);
    return value;
}
function readOptionalString(response, key) {
    const value = response[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function readRequiredPositiveInteger(response, key) {
    const value = response[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw remoteError(`workspace_response_invalid_${key}`);
    }
    return value;
}
function remoteError(code) {
    return Object.assign(new Error(code), { code });
}
//# sourceMappingURL=remote-client.js.map