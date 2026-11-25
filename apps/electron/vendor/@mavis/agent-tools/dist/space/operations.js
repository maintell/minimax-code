import { basename, join, sep } from 'node:path';
import { SPACE_DELETE_CONFIRM_TTL_MS } from './delete-confirmations.js';
import { DRIVE_CONFLICT_AUTO_RENAME, DRIVE_CONFLICT_FAIL, DRIVE_CONFLICT_MERGE, DRIVE_CONFLICT_OVERWRITE, DRIVE_LIST_ORDER_BY_NAME, DRIVE_LIST_ORDER_BY_SIZE, DRIVE_LIST_ORDER_BY_UPDATED_AT, DRIVE_MOVE_CONFLICT_AUTO_RENAME, DRIVE_MOVE_CONFLICT_FAIL, DRIVE_MOVE_CONFLICT_OVERWRITE, DRIVE_NODE_SOURCE_AGENT_DELIVERABLE, DRIVE_NODE_SOURCE_SYSTEM_GENERATED, DRIVE_NODE_SOURCE_USER_UPLOAD, DRIVE_NODE_TYPE_FILE, DRIVE_NODE_TYPE_FOLDER, SPACE_BATCH_MAX_NODES, SPACE_LIST_CATEGORIES, batchItemError, isDeployedWebsiteNode, isFolderNode, isLinkNode, } from './drive.js';
import { DRIVE_STATUS, SpaceError, toSpaceError } from './errors.js';
import { assertNotRoot, formatNode, getNodeById, isLegacyNodeId, legacyItemError, parseNodeId, parseTarget, resolveTarget, } from './nodes.js';
import { displayPath, fileExtension, inferMimeType, joinLibraryPath, libraryPath, localName, pathSegments, serverPath, } from './paths.js';
export const SPACE_LIST_DEFAULT_LIMIT = 50;
export const SPACE_SEARCH_DEFAULT_LIMIT = 20;
export const SPACE_MAX_PAGE_LIMIT = 100;
export const SPACE_RECURSIVE_MAX_FILES = 200;
export const SPACE_RECURSIVE_MAX_BYTES = 1024 * 1024 * 1024;
/** One space_upload call uploads at most this many local files. */
export const SPACE_BATCH_MAX_UPLOADS = 20;
const SEARCH_STAT_CONCURRENCY = 8;
const DOWNLOAD_CONCURRENCY = 4;
/** Existence checks before a folder download; each is one compute round trip on cloud. */
const LOCAL_CHECK_CONCURRENCY = 8;
const BATCH_RESOLVE_CONCURRENCY = 8;
const SPACE_SOURCE_VALUES = {
    upload: DRIVE_NODE_SOURCE_USER_UPLOAD,
    deliverable: DRIVE_NODE_SOURCE_AGENT_DELIVERABLE,
    system: DRIVE_NODE_SOURCE_SYSTEM_GENERATED,
};
export async function listSpace(ctx, input) {
    if (input.space_path !== undefined && input.node_id !== undefined) {
        throw new SpaceError('INVALID_ARGS', 'Give either space_path or node_id, not both.');
    }
    const nodeType = parseNodeType(input.type);
    const orderBy = parseOrderBy(input.order_by);
    const categories = parseCategories(input.categories);
    const sources = parseSources(input.sources);
    const fileExts = parseFileExts(input.file_exts);
    const favoriteOnly = input.favorite_only === true;
    const limit = boundedInteger(input.limit, 'limit', SPACE_LIST_DEFAULT_LIMIT, 1, SPACE_MAX_PAGE_LIMIT);
    const offset = boundedInteger(input.offset, 'offset', 0, 0);
    let dirPath;
    let parent;
    if (favoriteOnly) {
        // The server flattens favorites across folders and ignores the parent, so a parent here
        // would silently do nothing.
        if (input.space_path !== undefined || input.node_id !== undefined) {
            throw new SpaceError('INVALID_ARGS', 'favorite_only lists favorites across every folder; do not give space_path or node_id with it.');
        }
        dirPath = null;
        parent = {};
    }
    else if (input.node_id !== undefined) {
        const nodeId = parseNodeId(input.node_id);
        const folder = await getNodeById(ctx.drive, nodeId, ctx.signal);
        if (!isFolderNode(folder.node)) {
            throw new SpaceError('INVALID_ARGS', `${nodeId} is a file, not a folder.`);
        }
        dirPath = folder.path;
        parent = { parentId: nodeId };
    }
    else {
        const segments = pathSegments(input.space_path ?? '');
        dirPath = libraryPath(segments);
        // The root is listed without a parent, like the Space page.
        parent = segments.length === 0 ? {} : { parentPath: serverPath(segments) };
    }
    const list = await ctx.drive.listChildren({
        ...parent,
        ...(nodeType === undefined ? {} : { nodeType }),
        ...(orderBy === undefined ? {} : { orderBy }),
        ...(input.order_desc === true ? { orderDesc: true } : {}),
        ...(favoriteOnly ? { favoriteOnly: true } : {}),
        ...(categories.length > 0 ? { categories } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...(fileExts.length > 0 ? { fileExts } : {}),
        offset,
        limit,
    }, ctx.signal);
    return {
        dir: dirPath === null ? null : displayPath(dirPath, true),
        items: list.nodes.map((node) => formatNode(node, dirPath === null ? null : joinLibraryPath(dirPath, node.name))),
        has_more: list.has_more,
        next_offset: offset + list.nodes.length,
    };
}
export async function statSpace(ctx, input) {
    const target = parseTarget(input);
    assertNotRoot(target, 'inspected');
    const resolved = await resolveTarget(ctx.drive, target, ctx.signal);
    return { node: formatNode(resolved.node, resolved.path) };
}
export async function searchSpace(ctx, input) {
    const keyword = input.keyword.trim();
    if (!keyword)
        throw new SpaceError('INVALID_ARGS', 'keyword must not be empty.');
    const limit = boundedInteger(input.limit, 'limit', SPACE_SEARCH_DEFAULT_LIMIT, 1, SPACE_MAX_PAGE_LIMIT);
    const nodeType = parseNodeType(input.type);
    const result = await ctx.drive.searchFiles({
        keyword,
        // The server already searches files only when node_type is unset, so type: "file" needs
        // no field; only a folder search has to be asked for.
        ...(nodeType === DRIVE_NODE_TYPE_FOLDER ? { nodeType } : {}),
        offset: 0,
        limit,
    }, ctx.signal);
    const nodes = result.nodes.slice(0, limit);
    // Search results carry no path; stat each hit. One failed stat only nulls that path.
    const items = await mapWithConcurrency(nodes, SEARCH_STAT_CONCURRENCY, async (node) => {
        if (isLegacyNodeId(node.node_id))
            return formatNode(node, null);
        try {
            const resolved = await getNodeById(ctx.drive, node.node_id, ctx.signal);
            return formatNode(resolved.node, resolved.path);
        }
        catch {
            return formatNode(node, null);
        }
    });
    return { items, has_more: result.has_more || result.nodes.length > limit };
}
export async function quotaSpace(ctx) {
    const quota = await ctx.drive.getQuota(ctx.signal);
    return {
        used_bytes: quota.used_bytes,
        quota_bytes: quota.quota_bytes,
        available_bytes: quota.available_bytes,
        max_file_bytes: quota.max_file_bytes,
    };
}
/** Add or remove the favorite mark on up to SPACE_BATCH_MAX_NODES items; idempotent per item. */
export async function favoriteSpace(ctx, input) {
    const nodeIds = batchNodeIds(input.node_ids);
    const favorited = input.favorited === true;
    const results = await ctx.drive.updateFavorite({ node_ids: nodeIds, favorited }, ctx.signal);
    const { ok, failed } = splitBatchResults(results);
    return {
        favorited,
        updated: ok.map((item) => item.node_id),
        updated_count: ok.length,
        ...(failed.length > 0 ? { failed, failed_count: failed.length } : {}),
    };
}
/**
 * A pre-signed URL for one file, on the same user path the Space page uses: the server picks the
 * key by provenance and the user's watermark setting, and binds the file name. Never the agent
 * reread path, which serves the clean un-watermarked source.
 */
export async function downloadUrlSpace(ctx, input) {
    const target = parseTarget(input);
    assertNotRoot(target, 'downloaded');
    const resolved = await resolveTarget(ctx.drive, target, ctx.signal);
    const node = resolved.node;
    if (isFolderNode(node)) {
        throw new SpaceError('INVALID_ARGS', `${node.name} is a folder; space_download_url signs one file. Download a specific file inside it, or use space_download with recursive: true.`);
    }
    const formatted = formatNode(node, resolved.path);
    if (isLinkNode(node))
        return { node: formatted, link: formatted.link };
    const url = await ctx.drive.getDownloadUrl(node.node_id, ctx.signal);
    const expiresAt = presignExpiresAt(url);
    return {
        node: formatted,
        download_url: url,
        ...(expiresAt === undefined
            ? {}
            : {
                expires_at: expiresAt,
                expires_in_seconds: Math.max(0, Math.round((expiresAt - ctx.now()) / 1000)),
            }),
    };
}
// ---------------------------------------------------------------------------
// Download
export async function downloadSpace(ctx, input) {
    const target = parseTarget(input);
    assertNotRoot(target, 'downloaded');
    const rawOut = requireLocalPath(input.local_path);
    const out = await ctx.resolveLocalPath(rawOut);
    const overwrite = input.overwrite === true;
    const resolved = await resolveTarget(ctx.drive, target, ctx.signal);
    if (isFolderNode(resolved.node)) {
        if (input.recursive !== true) {
            throw new SpaceError('INVALID_ARGS', `${resolved.node.name} is a folder; pass recursive: true to download it.`);
        }
        return downloadFolder(ctx, resolved, out, overwrite);
    }
    if (isLinkNode(resolved.node)) {
        // A link has no content: return its url and write nothing.
        const node = formatNode(resolved.node, resolved.path);
        return { node, link: node.link };
    }
    const name = localName(resolved.node.name, resolved.node.node_id);
    const destination = (await isDirectoryTarget(ctx, rawOut, out)) ? join(out, name) : out;
    await assertWritable(ctx, destination, overwrite);
    const url = await ctx.drive.getDownloadUrl(resolved.node.node_id, ctx.signal);
    const saved = await saveObject(ctx, url, destination, resolved.node.node_id);
    return { node: formatNode(resolved.node, resolved.path), saved_to: destination, sha256: saved.sha256 };
}
async function downloadFolder(ctx, folder, out, overwrite) {
    const folderName = localName(folder.node.name, folder.node.node_id);
    const root = (await isExistingDirectory(ctx, out)) ? join(out, folderName) : out;
    const directories = [root];
    const files = [];
    let totalBytes = 0;
    let skippedWebsites = 0;
    let skippedLinks = 0;
    // Count the whole tree first; nothing is written when it is too large.
    const queue = [{ id: folder.node.node_id, local: root }];
    while (queue.length > 0) {
        const current = queue.shift();
        for (let offset = 0;;) {
            const page = await ctx.drive.listChildren({ parentId: current.id, offset, limit: SPACE_MAX_PAGE_LIMIT }, ctx.signal);
            for (const child of page.nodes) {
                const local = join(current.local, localName(child.name, child.node_id));
                if (isFolderNode(child)) {
                    directories.push(local);
                    queue.push({ id: child.node_id, local });
                }
                else if (isDeployedWebsiteNode(child)) {
                    skippedWebsites += 1;
                }
                else if (isLinkNode(child)) {
                    skippedLinks += 1;
                }
                else {
                    files.push({ node: child, destination: local });
                    totalBytes += child.size_bytes;
                }
            }
            if (files.length > SPACE_RECURSIVE_MAX_FILES || totalBytes > SPACE_RECURSIVE_MAX_BYTES) {
                throw new SpaceError('TOO_LARGE', `Folder exceeds the recursive download limit (${SPACE_RECURSIVE_MAX_FILES} files or 1 GB); download smaller subfolders or single files instead.`);
            }
            offset += page.nodes.length;
            if (!page.has_more || page.nodes.length === 0)
                break;
        }
    }
    await mapWithConcurrency(directories, LOCAL_CHECK_CONCURRENCY, async (directory) => {
        if ((await ctx.localFiles.kind(directory)) === 'file') {
            throw new SpaceError('LOCAL_EXISTS', `${directory} already exists and is not a folder.`);
        }
    });
    await mapWithConcurrency(files, LOCAL_CHECK_CONCURRENCY, (file) => assertWritable(ctx, file.destination, overwrite));
    // In order, so parents exist before their children.
    for (const directory of directories)
        await ctx.localFiles.mkdirp(directory);
    await mapWithConcurrency(files, DOWNLOAD_CONCURRENCY, async (file) => {
        const url = await ctx.drive.getDownloadUrl(file.node.node_id, ctx.signal);
        await saveObject(ctx, url, file.destination, file.node.node_id);
    });
    const output = {
        dir: formatNode(folder.node, folder.path),
        saved_to: `${root}${sep}`,
        files: files.length,
    };
    if (skippedWebsites > 0)
        output.skipped_websites = skippedWebsites;
    if (skippedLinks > 0)
        output.skipped_links = skippedLinks;
    return output;
}
async function saveObject(ctx, url, destination, nodeId) {
    const result = await ctx.localFiles.receive({
        url,
        destination,
        fetchImpl: ctx.fetchImpl,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    await bestEffort(() => ctx.hooks?.downloaded?.({ nodeId, sha256: result.sha256, localPath: destination }));
    return result;
}
/** A local path naming an existing folder (or ending with a separator) gets `<path>/<name>`. */
async function isDirectoryTarget(ctx, raw, resolved) {
    return raw.endsWith('/') || raw.endsWith(sep) || (await isExistingDirectory(ctx, resolved));
}
async function isExistingDirectory(ctx, path) {
    return (await ctx.localFiles.kind(path)) === 'directory';
}
async function assertWritable(ctx, destination, overwrite) {
    const kind = await ctx.localFiles.kind(destination);
    if (kind === undefined)
        return;
    if (kind === 'directory') {
        throw new SpaceError('LOCAL_EXISTS', `${destination} already exists and is a folder.`);
    }
    if (!overwrite) {
        throw new SpaceError('LOCAL_EXISTS', `${destination} already exists; pass overwrite: true to replace it or choose another local_path.`);
    }
}
export async function uploadSpace(ctx, input) {
    if (input.node_id !== undefined) {
        if (input.to_folder !== undefined || input.name !== undefined || input.on_conflict !== undefined) {
            throw new SpaceError('INVALID_ARGS', 'node_id overwrites an existing file; it cannot be combined with to_folder, name or on_conflict.');
        }
        const nodeId = parseNodeId(input.node_id);
        const expected = input.expect_updated_at === undefined
            ? undefined
            : boundedInteger(input.expect_updated_at, 'expect_updated_at', 0, 0);
        return overwriteFile(ctx, nodeId, await readLocal(ctx, input.local_path), expected);
    }
    if (input.expect_updated_at !== undefined) {
        throw new SpaceError('INVALID_ARGS', 'expect_updated_at requires node_id.');
    }
    if (input.to_folder === undefined) {
        throw new SpaceError('INVALID_ARGS', 'Give to_folder (use "/" for the Space root), or node_id to overwrite an existing file.');
    }
    const conflictPolicy = parseConflictPolicy(input.on_conflict);
    const name = input.name === undefined ? undefined : parseName(input.name, 'name');
    const local = await readLocal(ctx, input.local_path);
    return createFile(ctx, pathSegments(input.to_folder), name ?? basename(local.absolutePath), conflictPolicy, local);
}
/**
 * Upload several local files into one folder. Sequential, because each file is a prepare plus an
 * object POST plus a commit; a file that fails is reported and the rest still upload.
 */
export async function batchUploadSpace(ctx, input) {
    if (!Array.isArray(input.local_paths) || input.local_paths.length === 0) {
        throw new SpaceError('INVALID_ARGS', 'local_paths must contain at least one local file path.');
    }
    if (input.local_paths.length > SPACE_BATCH_MAX_UPLOADS) {
        throw new SpaceError('INVALID_ARGS', `local_paths must contain at most ${SPACE_BATCH_MAX_UPLOADS} paths; got ${input.local_paths.length}.`);
    }
    const parentSegments = pathSegments(input.to_folder);
    const conflictPolicy = parseConflictPolicy(input.on_conflict);
    const uploaded = [];
    const failed = [];
    for (const raw of input.local_paths) {
        const label = typeof raw === 'string' ? raw : String(raw);
        try {
            const local = await readLocal(ctx, requireLocalPath(raw));
            const result = await createFile(ctx, parentSegments, basename(local.absolutePath), conflictPolicy, local);
            uploaded.push({ node: result.node, source_path: result.source_path, sha256: result.sha256 });
        }
        catch (error) {
            const failure = toSpaceError(error);
            failed.push({ local_path: label, code: failure.code, message: failure.message });
        }
    }
    return {
        to_folder: displayPath(libraryPath(parentSegments), true),
        uploaded,
        uploaded_count: uploaded.length,
        ...(failed.length > 0 ? { failed, failed_count: failed.length } : {}),
    };
}
async function createFile(ctx, parentSegments, fileName, conflictPolicy, local) {
    // Root uses parent_id "" like the Space page; other folders use parent_path, which the
    // server creates level by level when missing.
    const parent = parentSegments.length === 0 ? { parent_id: '' } : { parent_path: serverPath(parentSegments) };
    const prepared = await ctx.drive.prepareUpload({ ...parent, file_name: fileName, size_bytes: local.size, conflict_policy: conflictPolicy }, ctx.signal);
    const committed = await transferAndCommit(ctx, prepared, fileName, local);
    const node = committed ?? preparedNode(ctx, prepared, fileName, local);
    const finalName = node.name || prepared.name || fileName;
    await recordUpload(ctx, local, node.node_id, false);
    return {
        node: formatNode(node, joinLibraryPath(libraryPath(parentSegments), finalName)),
        overwritten: false,
        source_path: local.realPath,
        sha256: local.sha256,
    };
}
async function overwriteFile(ctx, nodeId, local, expectedUpdatedAt) {
    const current = await getNodeById(ctx.drive, nodeId, ctx.signal);
    const node = current.node;
    if (isFolderNode(node)) {
        throw new SpaceError('INVALID_ARGS', `${node.name} is a folder; only files can be overwritten.`);
    }
    if (isDeployedWebsiteNode(node)) {
        throw new SpaceError('NOT_ALLOWED', `${node.name} is a published website and cannot be overwritten; upload as a new file instead.`);
    }
    if (isLinkNode(node)) {
        throw new SpaceError('NOT_ALLOWED', `${node.name} is a link and has no content to overwrite; upload as a new file instead.`);
    }
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== node.updated_at) {
        throw new SpaceError('CHANGED', `${node.name} was modified after the version you read (updated_at ${node.updated_at}, expected ${expectedUpdatedAt}).`);
    }
    if (fileExtension(basename(local.absolutePath)) !== fileExtension(node.name)) {
        throw new SpaceError('NOT_ALLOWED', `Overwriting cannot change the file extension of ${node.name}; upload as a new file instead.`);
    }
    const prepared = await ctx.drive.prepareUpload({
        parent_id: node.parent_id,
        file_name: node.name,
        size_bytes: local.size,
        conflict_policy: DRIVE_CONFLICT_OVERWRITE,
    }, ctx.signal);
    if (prepared.node_id !== nodeId) {
        // Renamed or moved after the lookup; nothing was uploaded.
        throw new SpaceError('CHANGED', `${node.name} was renamed or moved after it was read; nothing was uploaded.`);
    }
    const committed = await transferAndCommit(ctx, prepared, node.name, local);
    await recordUpload(ctx, local, nodeId, true);
    return {
        node: formatNode(committed ?? preparedNode(ctx, prepared, node.name, local), current.path),
        overwritten: true,
        source_path: local.realPath,
        sha256: local.sha256,
    };
}
/** PostObject then commit; on UPLOAD_NOT_READY resend the same form once. */
async function transferAndCommit(ctx, prepared, fileName, local) {
    const commit = () => ctx.drive.commitUpload({ node_id: prepared.node_id, upload_id: prepared.upload_id, size_bytes: local.size }, ctx.signal);
    await sendObject(ctx, prepared, fileName, local);
    try {
        return await commit();
    }
    catch (error) {
        if (!(error instanceof SpaceError && error.statusCode === DRIVE_STATUS.UPLOAD_NOT_READY)) {
            throw error;
        }
    }
    await sendObject(ctx, prepared, fileName, local);
    return commit();
}
async function sendObject(ctx, prepared, fileName, local) {
    await ctx.localFiles.send({
        prepared,
        fileName,
        mimeType: inferMimeType(fileName),
        local,
        fetchImpl: ctx.fetchImpl,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
}
/** Fallback when commit returns no node. */
function preparedNode(ctx, prepared, fileName, local) {
    return {
        node_id: prepared.node_id,
        node_type: DRIVE_NODE_TYPE_FILE,
        parent_id: prepared.parent_id ?? '',
        name: prepared.name ?? fileName,
        mime_type: inferMimeType(fileName),
        size_bytes: local.size,
        updated_at: ctx.now(),
    };
}
async function recordUpload(ctx, local, nodeId, overwritten) {
    await bestEffort(() => ctx.hooks?.uploaded?.({ nodeId, sha256: local.sha256, localPath: local.realPath, overwritten }));
}
async function readLocal(ctx, input) {
    const absolutePath = await ctx.resolveLocalPath(requireLocalPath(input));
    const file = await ctx.localFiles.probe(absolutePath);
    if (file.size === 0) {
        throw new SpaceError('INVALID_ARGS', `${absolutePath} is empty; Space does not accept empty files.`);
    }
    return { absolutePath, ...file };
}
// ---------------------------------------------------------------------------
// Organize
export async function mkdirSpace(ctx, input) {
    const segments = pathSegments(input.space_path);
    if (segments.length === 0) {
        throw new SpaceError('INVALID_ARGS', 'The Space root already exists; give a folder path.');
    }
    const parentSegments = segments.slice(0, -1);
    const parent = parentSegments.length === 0 ? { parent_id: '' } : { parent_path: serverPath(parentSegments) };
    // Merge returns the existing folder; missing parents are created by the server. When the
    // name is taken by something that cannot be merged (a file, website, link or session
    // folder) the server creates "name (N)", so the path is built from the returned name.
    const node = await ctx.drive.createFolder({ ...parent, name: segments[segments.length - 1], conflict_policy: DRIVE_CONFLICT_MERGE }, ctx.signal);
    return { node: formatNode(node, libraryPath([...parentSegments, node.name])) };
}
export async function moveSpace(ctx, input) {
    const target = parseTarget(input);
    assertNotRoot(target, 'moved');
    const destination = pathSegments(input.to_folder);
    const conflictPolicy = parseMoveConflictPolicy(input.on_conflict);
    const source = await resolveWritable(ctx, target);
    await ctx.drive.moveNode(source.node.node_id, serverPath(destination), conflictPolicy, ctx.signal);
    return updatedNode(ctx, source, joinLibraryPath(libraryPath(destination), source.node.name));
}
/**
 * Move up to SPACE_BATCH_MAX_NODES items into one destination. The server runs the items one by
 * one with the same conflict policy, descendants follow their ancestor, and one failing item
 * never fails the rest.
 */
export async function batchMoveSpace(ctx, input) {
    const nodeIds = batchNodeIds(input.node_ids);
    const destination = pathSegments(input.to_folder);
    const newParentId = destination.length === 0 ? '' : await resolveFolderId(ctx, destination);
    const conflictPolicy = parseMoveConflictPolicy(input.on_conflict);
    const results = await ctx.drive.batchMove({
        node_ids: nodeIds,
        new_parent_id: newParentId,
        ...(conflictPolicy === undefined ? {} : { conflict_policy: conflictPolicy }),
    }, ctx.signal);
    const { ok, failed } = splitBatchResults(results);
    return {
        to_folder: displayPath(libraryPath(destination), true),
        moved: ok.map((item) => ({ node_id: item.node_id, ...(item.name ? { name: item.name } : {}) })),
        moved_count: ok.length,
        ...(failed.length > 0 ? { failed, failed_count: failed.length } : {}),
    };
}
export async function renameSpace(ctx, input) {
    const newName = parseName(input.new_name, 'new_name');
    const target = parseTarget(input);
    assertNotRoot(target, 'renamed');
    const source = await resolveWritable(ctx, target);
    // A link name is a title, not a file name; only files keep their extension.
    if (!isFolderNode(source.node) &&
        !isLinkNode(source.node) &&
        fileExtension(source.node.name) !== fileExtension(newName)) {
        throw new SpaceError('NOT_ALLOWED', `Renaming cannot change the file extension of ${source.node.name}; keep .${fileExtension(source.node.name) || '(none)'}.`);
    }
    await ctx.drive.renameNode(source.node.node_id, newName, ctx.signal);
    const fallbackPath = source.path === null ? null : libraryPath([...pathSegments(source.path).slice(0, -1), newName]);
    return updatedNode(ctx, { node: { ...source.node, name: newName }, path: source.path }, fallbackPath);
}
async function resolveWritable(ctx, target) {
    const resolved = await resolveTarget(ctx.drive, target, ctx.signal);
    if (isLegacyNodeId(resolved.node.node_id))
        throw legacyItemError(resolved.node.node_id);
    return resolved;
}
/** Re-read after a successful change; fall back to the expected result. */
async function updatedNode(ctx, source, fallbackPath) {
    try {
        const updated = await getNodeById(ctx.drive, source.node.node_id, ctx.signal);
        return { node: formatNode(updated.node, updated.path ?? fallbackPath) };
    }
    catch {
        // The change already succeeded; do not report it as a failure.
        return { node: formatNode(source.node, fallbackPath) };
    }
}
export async function deleteSpace(ctx, input) {
    if (input.node_ids !== undefined) {
        if (input.space_path !== undefined || input.node_id !== undefined) {
            throw new SpaceError('INVALID_ARGS', 'Give node_ids for a batch, or space_path / node_id for one item, not both.');
        }
        const nodeIds = batchNodeIds(input.node_ids);
        return input.confirm_token === undefined
            ? previewBatchDelete(ctx, nodeIds)
            : confirmBatchDelete(ctx, nodeIds, input.confirm_token.trim());
    }
    const target = parseTarget(input);
    assertNotRoot(target, 'deleted');
    if (input.confirm_token === undefined)
        return previewDelete(ctx, target);
    return confirmDelete(ctx, target, input.confirm_token.trim());
}
/** Step one: dry run only. Never sends a delete without dry_run. */
async function previewDelete(ctx, target) {
    const resolved = await resolveWritable(ctx, target);
    const node = resolved.node;
    assertNotWebsite(node);
    const preview = await ctx.drive.previewDelete(node.node_id, ctx.signal);
    assertNoWebsites(node, preview);
    const affected = affectedOf(node, preview);
    const now = ctx.now();
    const token = ctx.randomToken();
    const expiresAt = now + SPACE_DELETE_CONFIRM_TTL_MS;
    ctx.confirmations.issue(token, {
        sessionId: ctx.sessionId,
        items: [{ node_id: node.node_id, updated_at: node.updated_at }],
        ...(affected ?? {}),
        expires_at: expiresAt,
    }, now);
    return {
        status: 'confirm_required',
        message: 'Nothing deleted yet. affected counts every Active file that will be deleted, including every file at any depth under a folder; folders themselves are not counted. ' +
            'Check that this is exactly what the user asked to delete (path, type, file count, size); deletion is permanent. ' +
            `Then call space_delete with node_id ${node.node_id} and confirm_token ${token} within 30 minutes.`,
        confirm_token: token,
        expires_at: expiresAt,
        node: formatNode(node, resolved.path),
        ...(affected ? { affected } : {}),
    };
}
/** Step two: one-time token, then re-check the node and its impact before deleting. */
async function confirmDelete(ctx, target, token) {
    const record = token ? ctx.confirmations.consume(token, ctx.sessionId, ctx.now()) : undefined;
    if (!record) {
        throw new SpaceError('CONFIRM_INVALID', 'confirm_token is unknown, expired or already used; call space_delete without confirm_token for a new preview.');
    }
    const expected = record.items[0];
    if (expected === undefined)
        throw confirmMismatch();
    if (target.kind === 'id' && target.nodeId !== expected.node_id)
        throw confirmMismatch();
    const resolved = await resolveTarget(ctx.drive, target, ctx.signal);
    const node = resolved.node;
    if (node.node_id !== expected.node_id)
        throw confirmMismatch();
    if (node.updated_at !== expected.updated_at) {
        throw new SpaceError('CHANGED', `${node.name} changed after the preview; preview it again and check the new result.`);
    }
    assertNotWebsite(node);
    const preview = await ctx.drive.previewDelete(node.node_id, ctx.signal);
    assertNoWebsites(node, preview);
    const affected = affectedOf(node, preview);
    if (record.file_count !== undefined && record.size_bytes !== undefined) {
        if (!affected ||
            affected.file_count !== record.file_count ||
            affected.size_bytes !== record.size_bytes) {
            throw new SpaceError('CHANGED', `What would be deleted under ${node.name} changed after the preview; preview it again and check the new result.`);
        }
    }
    await ctx.drive.deleteNode(node.node_id, ctx.signal);
    await bestEffort(() => ctx.hooks?.deleted?.(node.node_id));
    return {
        status: 'deleted',
        node: formatNode(node, resolved.path),
        ...(affected ? { affected } : {}),
    };
}
/**
 * Batch step one: one dry run for the whole selection and one token covering all of it, so the
 * model confirms once. The server counts a file under two selected folders once and skips
 * descendants of a selected ancestor.
 */
async function previewBatchDelete(ctx, nodeIds) {
    const resolved = await resolveBatchNodes(ctx, nodeIds);
    for (const entry of resolved)
        assertNotWebsite(entry.node);
    const preview = await ctx.drive.batchDelete({ node_ids: nodeIds, dry_run: true }, ctx.signal);
    assertNoWebsitesIn(preview.affected_websites);
    const { failed } = splitBatchResults(preview.results);
    const failedIds = new Set(failed.map((item) => item.node_id));
    const items = resolved
        .filter((entry) => !failedIds.has(entry.node.node_id))
        .map((entry) => formatNode(entry.node, entry.path));
    if (items.length === 0) {
        const detail = failed.map((item) => `${item.node_id} (${item.code})`).join(', ');
        throw new SpaceError('NOT_FOUND', `None of the ${nodeIds.length} items can be deleted: ${detail || 'no item resolved'}.`);
    }
    const affected = batchAffectedOf(preview);
    const now = ctx.now();
    const token = ctx.randomToken();
    const expiresAt = now + SPACE_DELETE_CONFIRM_TTL_MS;
    ctx.confirmations.issue(token, {
        sessionId: ctx.sessionId,
        items: items.map((item) => ({ node_id: item.node_id, updated_at: item.updated_at })),
        ...(affected ?? {}),
        expires_at: expiresAt,
    }, now);
    return {
        status: 'confirm_required',
        message: 'Nothing deleted yet. affected counts every Active file that will be deleted, including every file at any depth under a selected folder; a file under two selected folders counts once, and folders themselves are not counted. ' +
            'Check every item below against what the user asked to delete; deletion is permanent. ' +
            `Then call space_delete with the same node_ids and confirm_token ${token} within 30 minutes.`,
        confirm_token: token,
        expires_at: expiresAt,
        items,
        ...(affected ? { affected } : {}),
        ...(failed.length > 0 ? { failed, failed_count: failed.length } : {}),
    };
}
/** Batch step two: one token for the whole selection, re-checked with a second dry run. */
async function confirmBatchDelete(ctx, nodeIds, token) {
    const record = token ? ctx.confirmations.consume(token, ctx.sessionId, ctx.now()) : undefined;
    if (!record) {
        throw new SpaceError('CONFIRM_INVALID', 'confirm_token is unknown, expired or already used; call space_delete without confirm_token for a new preview.');
    }
    if (!sameIds(record.items.map((item) => item.node_id), nodeIds))
        throw confirmMismatch();
    // Deleting by node_id deletes exactly what was previewed, so the second dry run is what
    // catches a selection that grew or gained a published website since the preview.
    const preview = await ctx.drive.batchDelete({ node_ids: nodeIds, dry_run: true }, ctx.signal);
    assertNoWebsitesIn(preview.affected_websites);
    const affected = batchAffectedOf(preview);
    if (record.file_count !== undefined && record.size_bytes !== undefined) {
        if (!affected ||
            affected.file_count !== record.file_count ||
            affected.size_bytes !== record.size_bytes) {
            throw new SpaceError('CHANGED', `What would be deleted changed after the preview (${record.file_count} files / ${record.size_bytes} bytes then, ${preview.affected_file_count ?? 'unknown'} / ${preview.affected_size_bytes ?? 'unknown'} now); preview the batch again and check the new result.`);
        }
    }
    const result = await ctx.drive.batchDelete({ node_ids: nodeIds, dry_run: false }, ctx.signal);
    const { ok, failed } = splitBatchResults(result.results);
    for (const item of ok)
        await bestEffort(() => ctx.hooks?.deleted?.(item.node_id));
    return {
        status: 'deleted',
        deleted: ok.map((item) => item.node_id),
        deleted_count: ok.length,
        ...(failed.length > 0 ? { failed, failed_count: failed.length } : {}),
    };
}
function batchAffectedOf(preview) {
    if (preview.affected_file_count === undefined || preview.affected_size_bytes === undefined) {
        return undefined;
    }
    return { file_count: preview.affected_file_count, size_bytes: preview.affected_size_bytes };
}
async function resolveBatchNodes(ctx, nodeIds) {
    const resolved = await mapWithConcurrency(nodeIds, BATCH_RESOLVE_CONCURRENCY, async (id) => {
        try {
            return await getNodeById(ctx.drive, id, ctx.signal);
        }
        catch {
            // The dry run reports the same item as a failure, with the server's own code.
            return undefined;
        }
    });
    return resolved.filter((entry) => entry !== undefined);
}
function assertNoWebsitesIn(websites) {
    if (websites.length === 0)
        return;
    const names = websites.map((website) => website.name).join(', ');
    throw new SpaceError('NOT_ALLOWED', `The selection contains published websites (${names}) and cannot be deleted here; ask the user to delete them on the Space page.`);
}
function sameIds(left, right) {
    if (left.length !== right.length)
        return false;
    const known = new Set(left);
    return right.every((id) => known.has(id));
}
function assertNotWebsite(node) {
    if (isDeployedWebsiteNode(node)) {
        throw new SpaceError('NOT_ALLOWED', `${node.name} is a published website and cannot be deleted here; ask the user to delete it on the Space page.`);
    }
}
function assertNoWebsites(node, preview) {
    if (preview.affected_websites.length === 0)
        return;
    const names = preview.affected_websites.map((website) => website.name).join(', ');
    throw new SpaceError('NOT_ALLOWED', `${node.name} contains published websites (${names}) and cannot be deleted here; ask the user to delete it on the Space page.`);
}
/** Files count themselves; folders use the dry-run totals when the server reports them. */
function affectedOf(node, preview) {
    if (!isFolderNode(node))
        return { file_count: 1, size_bytes: node.size_bytes };
    if (preview.affected_file_count === undefined || preview.affected_size_bytes === undefined) {
        return undefined;
    }
    return { file_count: preview.affected_file_count, size_bytes: preview.affected_size_bytes };
}
function confirmMismatch() {
    return new SpaceError('CONFIRM_INVALID', 'confirm_token belongs to a different item; preview this item again.');
}
// ---------------------------------------------------------------------------
// Helpers
function parseNodeType(value) {
    if (value === undefined)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'file')
        return DRIVE_NODE_TYPE_FILE;
    if (normalized === 'folder')
        return DRIVE_NODE_TYPE_FOLDER;
    throw new SpaceError('INVALID_ARGS', 'type must be file or folder.');
}
function parseOrderBy(value) {
    if (value === undefined)
        return undefined;
    switch (value.trim().toLowerCase()) {
        case 'name':
            return DRIVE_LIST_ORDER_BY_NAME;
        case 'size':
            return DRIVE_LIST_ORDER_BY_SIZE;
        case 'updated_at':
            return DRIVE_LIST_ORDER_BY_UPDATED_AT;
        default:
            throw new SpaceError('INVALID_ARGS', 'order_by must be name, size or updated_at.');
    }
}
function parseMoveConflictPolicy(value) {
    if (value === undefined)
        return undefined;
    switch (value.trim().toLowerCase()) {
        case 'fail':
            return DRIVE_MOVE_CONFLICT_FAIL;
        case 'rename':
            return DRIVE_MOVE_CONFLICT_AUTO_RENAME;
        case 'overwrite':
            return DRIVE_MOVE_CONFLICT_OVERWRITE;
        default:
            throw new SpaceError('INVALID_ARGS', 'on_conflict must be fail, rename or overwrite.');
    }
}
function stringList(value, field) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        throw new SpaceError('INVALID_ARGS', `${field} must be an array of strings.`);
    }
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string') {
            throw new SpaceError('INVALID_ARGS', `${field} must be an array of strings.`);
        }
        const item = raw.trim();
        if (item && !out.includes(item))
            out.push(item);
    }
    return out;
}
function parseCategories(value) {
    const out = [];
    for (const raw of stringList(value, 'categories')) {
        const item = raw.toLowerCase();
        if (!SPACE_LIST_CATEGORIES.includes(item)) {
            throw new SpaceError('INVALID_ARGS', `Unknown category "${raw}". Use one of: ${SPACE_LIST_CATEGORIES.join(', ')}.`);
        }
        if (!out.includes(item))
            out.push(item);
    }
    return out;
}
function parseSources(value) {
    const out = [];
    for (const raw of stringList(value, 'sources')) {
        const source = SPACE_SOURCE_VALUES[raw.toLowerCase()];
        if (source === undefined) {
            throw new SpaceError('INVALID_ARGS', `Unknown source "${raw}". Use one of: ${Object.keys(SPACE_SOURCE_VALUES).join(', ')}.`);
        }
        if (!out.includes(source))
            out.push(source);
    }
    return out;
}
/** Extensions without the dot, lowercased; the server normalizes the same way. */
function parseFileExts(value) {
    const out = [];
    for (const raw of stringList(value, 'file_exts')) {
        const item = raw.replace(/^\.+/u, '').toLowerCase();
        if (item && !out.includes(item))
            out.push(item);
    }
    return out;
}
/** De-duplicated, legacy-free node ids for one batch request. */
function batchNodeIds(value) {
    if (!Array.isArray(value)) {
        throw new SpaceError('INVALID_ARGS', 'node_ids must be an array of node_id strings.');
    }
    const out = [];
    for (const raw of value) {
        if (typeof raw !== 'string') {
            throw new SpaceError('INVALID_ARGS', 'node_ids must be an array of node_id strings.');
        }
        const id = parseNodeId(raw);
        if (!out.includes(id))
            out.push(id);
    }
    if (out.length === 0) {
        throw new SpaceError('INVALID_ARGS', 'node_ids must contain at least one node_id.');
    }
    if (out.length > SPACE_BATCH_MAX_NODES) {
        throw new SpaceError('INVALID_ARGS', `node_ids must contain at most ${SPACE_BATCH_MAX_NODES} ids; got ${out.length}.`);
    }
    return out;
}
function splitBatchResults(results) {
    const ok = [];
    const failed = [];
    for (const item of results) {
        const error = batchItemError(item);
        if (error === undefined)
            ok.push(item);
        else
            failed.push({ node_id: item.node_id, code: error.code, message: error.message });
    }
    return { ok, failed };
}
async function resolveFolderId(ctx, segments) {
    const result = await ctx.drive.getFileByPath(serverPath(segments), ctx.signal);
    if (!isFolderNode(result.node)) {
        throw new SpaceError('INVALID_ARGS', `${libraryPath(segments)} is a file, not a folder.`);
    }
    return result.node.node_id;
}
/** OSS signs an absolute unix second into `Expires`; anything else is left unclaimed. */
function presignExpiresAt(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return undefined;
    }
    const raw = parsed.searchParams.get('Expires');
    if (raw === null || !/^\d+$/u.test(raw))
        return undefined;
    const seconds = Number(raw);
    if (!Number.isSafeInteger(seconds) || seconds < 1_000_000_000)
        return undefined;
    return seconds * 1000;
}
function parseConflictPolicy(value) {
    const normalized = (value ?? 'fail').trim().toLowerCase();
    if (normalized === 'fail')
        return DRIVE_CONFLICT_FAIL;
    if (normalized === 'rename')
        return DRIVE_CONFLICT_AUTO_RENAME;
    throw new SpaceError('INVALID_ARGS', 'on_conflict must be fail or rename.');
}
function parseName(value, field) {
    const name = value.trim();
    if (!name || name.includes('/')) {
        throw new SpaceError('INVALID_ARGS', `${field} must be a non-empty name without '/'.`);
    }
    return name;
}
function requireLocalPath(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new SpaceError('INVALID_ARGS', 'local_path must not be empty.');
    }
    return value.trim();
}
function boundedInteger(value, name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    if (value === undefined)
        return fallback;
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        const range = maximum === Number.MAX_SAFE_INTEGER ? `>= ${minimum}` : `from ${minimum} to ${maximum}`;
        throw new SpaceError('INVALID_ARGS', `${name} must be an integer ${range}.`);
    }
    return value;
}
async function bestEffort(action) {
    try {
        await action();
    }
    catch {
        // Host bookkeeping after a successful remote change never fails the tool.
    }
}
/**
 * Run `mapper` with bounded concurrency. After the first failure no new item starts;
 * in-flight items settle before the first error is rethrown.
 */
export async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let next = 0;
    let failure;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (failure === undefined && next < items.length) {
            const index = next;
            next += 1;
            try {
                results[index] = await mapper(items[index], index);
            }
            catch (error) {
                failure ??= { error };
            }
        }
    });
    await Promise.all(workers);
    if (failure !== undefined)
        throw failure.error;
    return results;
}
//# sourceMappingURL=operations.js.map