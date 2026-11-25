import { isDeployedWebsiteNode, isFolderNode, isLinkNode, } from './drive.js';
import { DRIVE_STATUS, SpaceError } from './errors.js';
import { displayPath, libraryPath, pathSegments, serverPath } from './paths.js';
export function isLegacyNodeId(nodeId) {
    return nodeId.startsWith('cs_');
}
/** Every drive route rejects legacy (cs_) items, so the tools refuse them up front. */
export function legacyItemError(nodeId) {
    return new SpaceError('NOT_ALLOWED', `${nodeId} is a legacy item (cs_ id) and cannot be read or changed. Read the local copy of the attachment instead, or ask the user to download it from the legacy items on the Space page.`);
}
export function formatNode(node, path) {
    const folder = isFolderNode(node);
    const link = isLinkNode(node);
    const output = {
        node_id: node.node_id,
        path: path === null ? null : displayPath(path, folder),
        name: node.name,
        type: folder ? 'folder' : 'file',
        updated_at: node.updated_at,
        readonly: isLegacyNodeId(node.node_id),
    };
    if (!folder) {
        output.size_bytes = link ? 0 : node.size_bytes;
        if (node.mime_type)
            output.mime_type = node.mime_type;
    }
    if (isDeployedWebsiteNode(node))
        output.website = true;
    if (link)
        output.link = node.cdn_url ?? '';
    if (node.is_favorited !== undefined)
        output.is_favorited = node.is_favorited;
    return output;
}
/** A target is `space_path` or `node_id`, exactly one. Legacy ids are refused here. */
export function parseTarget(input) {
    if (input.space_path !== undefined && input.node_id !== undefined) {
        throw new SpaceError('INVALID_ARGS', 'Give either space_path or node_id, not both.');
    }
    if (input.node_id !== undefined)
        return { kind: 'id', nodeId: parseNodeId(input.node_id) };
    if (input.space_path === undefined) {
        throw new SpaceError('INVALID_ARGS', 'Give space_path or node_id.');
    }
    return { kind: 'path', segments: pathSegments(input.space_path) };
}
export function parseNodeId(value) {
    const nodeId = value.trim();
    if (!nodeId)
        throw new SpaceError('INVALID_ARGS', 'node_id must not be empty.');
    if (isLegacyNodeId(nodeId))
        throw legacyItemError(nodeId);
    return nodeId;
}
export function assertNotRoot(target, action) {
    if (target.kind === 'path' && target.segments.length === 0) {
        throw new SpaceError('INVALID_ARGS', `The Space root is not an item and cannot be ${action}.`);
    }
}
/** A lookup by id answers INVALID_PARAMS for a node that is gone. */
export async function getNodeById(drive, nodeId, signal) {
    try {
        const result = await drive.getFile(nodeId, signal);
        return { node: result.node, path: result.path ?? null };
    }
    catch (error) {
        if (error instanceof SpaceError && error.statusCode === DRIVE_STATUS.INVALID_PARAMS) {
            throw new SpaceError('NOT_FOUND', `No item found with node_id ${nodeId}.`);
        }
        throw error;
    }
}
/** Resolve a target to its node; the root is rejected. */
export async function resolveTarget(drive, target, signal) {
    if (target.kind === 'id')
        return getNodeById(drive, target.nodeId, signal);
    assertNotRoot(target, 'used here');
    const result = await drive.getFileByPath(serverPath(target.segments), signal);
    return { node: result.node, path: result.path ?? libraryPath(target.segments) };
}
//# sourceMappingURL=nodes.js.map