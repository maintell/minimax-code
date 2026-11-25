import { SpaceError, spaceErrorFromBusinessStatus } from './errors.js';
export const DRIVE_NODE_TYPE_FOLDER = 1;
export const DRIVE_NODE_TYPE_FILE = 2;
export const DRIVE_CONFLICT_FAIL = 1;
export const DRIVE_CONFLICT_OVERWRITE = 2;
export const DRIVE_CONFLICT_AUTO_RENAME = 3;
export const DRIVE_CONFLICT_MERGE = 4;
/**
 * Move conflict policy (`DriveConflictPolicy`). Unset / 0 also means fail. This is a different
 * enum from the upload `conflict_policy` above, even though the numbers line up.
 */
export const DRIVE_MOVE_CONFLICT_FAIL = 1;
export const DRIVE_MOVE_CONFLICT_OVERWRITE = 2;
export const DRIVE_MOVE_CONFLICT_AUTO_RENAME = 3;
export const DRIVE_MOVE_CONFLICT_MERGE = 4;
/** List order (`DriveListOrderBy`). Unset / 0 is name ascending; folders always come first. */
export const DRIVE_LIST_ORDER_BY_NAME = 1;
export const DRIVE_LIST_ORDER_BY_SIZE = 2;
export const DRIVE_LIST_ORDER_BY_UPDATED_AT = 3;
/** Node provenance (`DriveNodeSource`). */
export const DRIVE_NODE_SOURCE_USER_UPLOAD = 1;
export const DRIVE_NODE_SOURCE_AGENT_DELIVERABLE = 2;
export const DRIVE_NODE_SOURCE_SYSTEM_GENERATED = 3;
/** The only `categories` values the server accepts; anything else is INVALID_PARAMS. */
export const SPACE_LIST_CATEGORIES = [
    'documents',
    'excel',
    'ppt',
    'images',
    'videos',
    'audio',
    'website',
    'other',
    'link',
];
/** Server cap on one batch request, counted after de-duplication. */
export const SPACE_BATCH_MAX_NODES = 100;
/** Same rule as the Space page: trust `is_deployed_site`, else metadata and cdn_url. */
export function isDeployedWebsiteNode(node) {
    if (typeof node.is_deployed_site === 'boolean')
        return node.is_deployed_site;
    const metadata = parseMetadata(node.metadata);
    const subtype = metadata?.website?.subtype;
    if (subtype === 'deployed_site')
        return true;
    return node.category === 'website' && !node.oss_key && Boolean(node.cdn_url);
}
/** Link node: its url is `cdn_url` and it has no content. */
export function isLinkNode(node) {
    return node.category === 'link' && !isFolderNode(node);
}
export function isFolderNode(node) {
    return node.node_type === DRIVE_NODE_TYPE_FOLDER;
}
/** Business failures arrive as a successful response with a non-zero `base_resp.status_code`. */
export function throwIfDriveBusinessFailure(response) {
    const baseResp = response.base_resp;
    if (!baseResp || typeof baseResp !== 'object' || Array.isArray(baseResp))
        return;
    const record = baseResp;
    const statusCode = toDriveNumber(record.status_code);
    if (statusCode === undefined || statusCode === 0)
        return;
    const message = typeof record.status_msg === 'string' && record.status_msg.trim()
        ? record.status_msg.trim()
        : 'Space request failed';
    throw spaceErrorFromBusinessStatus(statusCode, message);
}
/** Accept a JSON number or a decimal string (i64 fields). */
export function toDriveNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && /^-?\d+$/u.test(value.trim()))
        return Number(value.trim());
    return undefined;
}
export function parseDriveNode(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidResponse('node is missing');
    }
    const item = value;
    const nodeId = idField(item.node_id);
    if (!nodeId)
        throw invalidResponse('node.node_id is missing');
    const node = {
        node_id: nodeId,
        node_type: toDriveNumber(item.node_type) ?? DRIVE_NODE_TYPE_FILE,
        parent_id: idField(item.parent_id) ?? '',
        name: typeof item.name === 'string' ? item.name : '',
        size_bytes: toDriveNumber(item.size_bytes) ?? 0,
        updated_at: toDriveNumber(item.updated_at) ?? 0,
    };
    for (const key of ['file_ext', 'category', 'mime_type', 'cdn_url', 'oss_key']) {
        const field = stringField(item[key]);
        if (field)
            node[key] = field;
    }
    const childCount = toDriveNumber(item.child_count);
    if (childCount !== undefined)
        node.child_count = childCount;
    const createdAt = toDriveNumber(item.created_at);
    if (createdAt !== undefined)
        node.created_at = createdAt;
    // archon-biz answers `metadata`, archon-server `metadata_json`.
    const metadata = item.metadata ?? item.metadata_json;
    if (metadata !== undefined && metadata !== null)
        node.metadata = metadata;
    if (typeof item.is_deployed_site === 'boolean')
        node.is_deployed_site = item.is_deployed_site;
    const favorited = item.is_favorited ?? item.isFavorited;
    if (typeof favorited === 'boolean')
        node.is_favorited = favorited;
    else if (typeof favorited === 'number')
        node.is_favorited = favorited !== 0;
    return node;
}
export function parseNodeWithPath(response) {
    const node = parseDriveNode(response.node);
    const path = typeof response.path === 'string' && response.path.trim() ? response.path : undefined;
    return path === undefined ? { node } : { node, path };
}
export function parseNodeList(response) {
    const nodes = Array.isArray(response.nodes) ? response.nodes.map(parseDriveNode) : [];
    const hasMore = response.has_more ?? response.hasMore;
    return { nodes, has_more: hasMore === true };
}
export function parsePreparedUpload(response) {
    const nodeId = idField(response.node_id);
    const uploadId = idField(response.upload_id);
    if (!nodeId || !uploadId)
        throw invalidResponse('node_id or upload_id is missing');
    // The server issues a PostObject instruction or a presigned PUT, never both.
    const uploadUrl = stringField(response.upload_url);
    const instruction = response.upload_instruction;
    if (!uploadUrl && (instruction === undefined || instruction === null)) {
        throw invalidResponse('upload_instruction or upload_url is missing');
    }
    const contentType = stringField(response.content_type);
    return {
        node_id: nodeId,
        upload_id: uploadId,
        ...(uploadUrl
            ? { upload_url: uploadUrl, ...(contentType ? { content_type: contentType } : {}) }
            : { upload_instruction: parseUploadInstruction(instruction) }),
        ...(stringField(response.name) ? { name: stringField(response.name) } : {}),
        ...(idField(response.parent_id) ? { parent_id: idField(response.parent_id) } : {}),
    };
}
export function parseDeletePreview(response) {
    const websites = Array.isArray(response.affected_websites)
        ? response.affected_websites.map(parseDriveNode)
        : [];
    const fileCount = toDriveNumber(response.affected_file_count);
    const sizeBytes = toDriveNumber(response.affected_size_bytes);
    return {
        affected_websites: websites,
        ...(fileCount !== undefined ? { affected_file_count: fileCount } : {}),
        ...(sizeBytes !== undefined ? { affected_size_bytes: sizeBytes } : {}),
    };
}
export function parseBatchItemResults(response) {
    const raw = Array.isArray(response.results) ? response.results : [];
    return raw.map((value) => {
        const item = (value ?? {});
        const nodeId = idField(item.node_id);
        if (!nodeId)
            throw invalidResponse('results[].node_id is missing');
        const statusCode = toDriveNumber(item.status_code);
        const name = stringField(item.name);
        const statusMsg = stringField(item.status_msg);
        return {
            node_id: nodeId,
            ...(name ? { name } : {}),
            ...(statusCode !== undefined ? { status_code: statusCode } : {}),
            ...(statusMsg ? { status_msg: statusMsg } : {}),
        };
    });
}
export function parseBatchDeleteResult(response) {
    const fileCount = toDriveNumber(response.affected_file_count);
    const sizeBytes = toDriveNumber(response.affected_size_bytes);
    return {
        results: parseBatchItemResults(response),
        affected_websites: Array.isArray(response.affected_websites)
            ? response.affected_websites.map(parseDriveNode)
            : [],
        ...(fileCount !== undefined ? { affected_file_count: fileCount } : {}),
        ...(sizeBytes !== undefined ? { affected_size_bytes: sizeBytes } : {}),
    };
}
/** A batch item succeeded when it carries no business status code. */
export function isBatchItemOk(item) {
    return item.status_code === undefined || item.status_code === 0;
}
/** The per-item failure, mapped through the same contract as a single-item failure. */
export function batchItemError(item) {
    if (isBatchItemOk(item))
        return undefined;
    return spaceErrorFromBusinessStatus(item.status_code ?? 0, item.status_msg ?? `${item.node_id} failed`);
}
export function requireDownloadUrl(response) {
    const url = stringField(response.download_url);
    if (!url)
        throw invalidResponse('download_url is missing');
    return url;
}
function parseUploadInstruction(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidResponse('upload_instruction is missing');
    }
    const item = value;
    const url = stringField(item.url);
    if (!url)
        throw invalidResponse('upload_instruction.url is missing');
    const fields = {};
    if (item.form_fields !== undefined && item.form_fields !== null) {
        if (typeof item.form_fields !== 'object' || Array.isArray(item.form_fields)) {
            throw invalidResponse('upload_instruction.form_fields is invalid');
        }
        for (const [key, field] of Object.entries(item.form_fields)) {
            if (typeof field !== 'string') {
                throw invalidResponse('upload_instruction.form_fields is invalid');
            }
            fields[key] = field;
        }
    }
    const method = stringField(item.method);
    return method === undefined ? { url, form_fields: fields } : { method, url, form_fields: fields };
}
function parseMetadata(value) {
    if (typeof value !== 'string')
        return value;
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
}
function stringField(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function idField(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return String(value);
    return stringField(value);
}
function invalidResponse(detail) {
    return new SpaceError('UPSTREAM', `Invalid drive response: ${detail}.`);
}
//# sourceMappingURL=drive.js.map