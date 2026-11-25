import { randomBytes } from 'node:crypto';
import { defineRuntimeTool, } from '@mavis/agent-core/tools';
import { Type } from '@sinclair/typebox';
import { sharedSpaceDeleteConfirmations, } from './delete-confirmations.js';
import { nodeFsSpaceLocalFileAccess } from './local-files.js';
import { SpaceError, toSpaceError } from './errors.js';
import { spaceSkillRequiredResult } from './skill-gate.js';
import { batchMoveSpace, batchUploadSpace, deleteSpace, downloadSpace, downloadUrlSpace, favoriteSpace, listSpace, mkdirSpace, moveSpace, quotaSpace, renameSpace, searchSpace, statSpace, uploadSpace, } from './operations.js';
import { SPACE_DELETE_TOOL_NAME, SPACE_DOWNLOAD_TOOL_NAME, SPACE_DOWNLOAD_URL_TOOL_NAME, SPACE_FAVORITE_TOOL_NAME, SPACE_LIST_TOOL_NAME, SPACE_MKDIR_TOOL_NAME, SPACE_MOVE_TOOL_NAME, SPACE_QUOTA_TOOL_NAME, SPACE_RENAME_TOOL_NAME, SPACE_SEARCH_TOOL_NAME, SPACE_STAT_TOOL_NAME, SPACE_UPLOAD_TOOL_NAME, } from './tool-names.js';
export { SPACE_REMOTE_WRITE_TOOL_NAMES, SPACE_TOOL_NAMES, SPACE_UPLOAD_TOOL_NAME, } from './tool-names.js';
const spacePath = (description) => Type.String({ description });
const nodeIdField = Type.Optional(Type.String({
    description: 'node_id of the item. Prefer it over space_path when you have it.',
}));
const itemPath = Type.Optional(spacePath('Space path of the item, such as "/Project A/report.docx". Give this or node_id.'));
const nodeIdsField = Type.Optional(Type.Array(Type.String(), {
    minItems: 1,
    maxItems: 100,
    description: 'node_id of each item, for a batch of up to 100. Give this or a single target.',
}));
/**
 * Every space_* description states the precondition the skill gate enforces, so a model that has
 * not read the skill yet learns the next step from the tool list and not only from a refusal.
 */
const SPACE_SKILL_REQUIRED = 'Requires the "space" skill: call the skill tool with name "space" first in this session; until then every space_* call does nothing and changes nothing. ';
export const SpaceListToolDef = {
    name: SPACE_LIST_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        "List a folder in the user's Space (资料空间, persistent files shared across sessions). " +
        'Give space_path ("/" or omit for the root) or the folder node_id. ' +
        'favorite_only: true lists favorites across every folder and takes no space_path or node_id. ' +
        'order_by is name, size or updated_at; folders always come first whatever the order. ' +
        'categories, sources and file_exts filter files only; folders are always returned. ' +
        'Returns {dir, items, has_more, next_offset}; items have node_id, path, name, type, size_bytes, updated_at, is_favorited.',
    schema: Type.Object({
        space_path: Type.Optional(spacePath('Folder path such as "/Project A". Omit for the root.')),
        node_id: Type.Optional(Type.String({ description: 'node_id of the folder.' })),
        type: Type.Optional(Type.Union([Type.Literal('file'), Type.Literal('folder')], {
            description: 'Only files or only folders.',
        })),
        order_by: Type.Optional(Type.Union([Type.Literal('name'), Type.Literal('size'), Type.Literal('updated_at')], {
            description: 'Default: name ascending.',
        })),
        order_desc: Type.Optional(Type.Boolean({ description: 'Descending. Only applies when order_by is set.' })),
        favorite_only: Type.Optional(Type.Boolean({
            description: 'List favorites across every folder. Do not combine with space_path or node_id.',
        })),
        categories: Type.Optional(Type.Array(Type.String(), {
            description: 'Any of documents, excel, ppt, images, videos, audio, website, other, link.',
        })),
        sources: Type.Optional(Type.Array(Type.String(), { description: 'Any of upload, deliverable, system.' })),
        file_exts: Type.Optional(Type.Array(Type.String(), { description: 'Extensions without the dot, such as ["pdf","png"].' })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Default 50.' })),
        offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Use next_offset to page.' })),
    }),
};
export const SpaceStatToolDef = {
    name: SPACE_STAT_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Get one Space (资料空间) item by space_path or node_id: {node}. ' +
        'Keep node.updated_at to pass as expect_updated_at when overwriting. A link has node.link.',
    schema: Type.Object({ space_path: itemPath, node_id: nodeIdField }),
};
export const SpaceSearchToolDef = {
    name: SPACE_SEARCH_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        "Search the user's Space (资料空间) by file or folder name. " +
        'Searches files only unless type is folder. Returns {items, has_more}; items carry is_favorited.',
    schema: Type.Object({
        keyword: Type.String({ description: 'Part of the name.' }),
        type: Type.Optional(Type.Union([Type.Literal('file'), Type.Literal('folder')], {
            description: 'Default: files only.',
        })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Default 20.' })),
    }),
};
export const SpaceDownloadToolDef = {
    name: SPACE_DOWNLOAD_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Download a Space (资料空间) file, or a folder with recursive: true, to a local path. ' +
        'local_path may be relative to the working directory, absolute, or start with "~"; on the desktop that is any path the permission engine allows, in the cloud it must stay inside the working directory. ' +
        'local_path is the file to write, or a folder (existing, or ending with "/") that receives <local_path>/<name>. ' +
        'Fails with LOCAL_EXISTS instead of replacing a local file unless overwrite is true. ' +
        'A link writes nothing and returns {node, link}. Folders: up to 200 files and 1 GB; websites and links inside are skipped. ' +
        'Returns {node, saved_to, sha256} or {dir, saved_to, files}.',
    executionMode: 'sequential',
    schema: Type.Object({
        space_path: itemPath,
        node_id: nodeIdField,
        local_path: Type.String({
            description: 'Local file or folder path: relative to the working directory, absolute, or starting with "~".',
        }),
        recursive: Type.Optional(Type.Boolean({ description: 'Required to download a folder.' })),
        overwrite: Type.Optional(Type.Boolean({ description: 'Replace an existing local file.' })),
    }),
};
export const SpaceUploadToolDef = {
    name: SPACE_UPLOAD_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        "Upload local files to the user's Space (资料空间). Pick a to_folder that keeps the tree tidy and organized; do not default to the root. " +
        'One new file: give local_path, to_folder ("/" for the root), optional name and on_conflict (fail or rename; default fail); returns {node, overwritten, source_path, sha256}. ' +
        'Several new files into one folder: give local_paths (up to 20) instead of local_path, with to_folder and on_conflict; returns {to_folder, uploaded, uploaded_count} and, for the ones that failed, {failed, failed_count} — a failure never stops the rest. ' +
        'Overwrite an existing file: give its node_id and expect_updated_at (node.updated_at you read); the extension must stay the same.',
    executionMode: 'sequential',
    schema: Type.Object({
        local_path: Type.Optional(Type.String({ description: 'One local file. Relative to the working directory, absolute, or starting with "~".' })),
        local_paths: Type.Optional(Type.Array(Type.String(), {
            minItems: 1,
            maxItems: 20,
            description: 'Several local files for one to_folder. Cannot be combined with local_path, name, node_id or expect_updated_at.',
        })),
        to_folder: Type.Optional(spacePath('Destination folder for a new file, such as "/Project A".')),
        name: Type.Optional(Type.String({ description: 'File name in Space. Default: the local name.' })),
        on_conflict: Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('rename')], {
            description: 'When the name is taken: fail (NAME_CONFLICT) or rename to the first free "name (N).ext".',
        })),
        node_id: Type.Optional(Type.String({ description: 'Overwrite this existing file.' })),
        expect_updated_at: Type.Optional(Type.Integer({ minimum: 0, description: 'With node_id: fail with CHANGED if the file changed since.' })),
    }),
};
export const SpaceMkdirToolDef = {
    name: SPACE_MKDIR_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Create a Space (资料空间) folder, including missing parents. An existing folder is returned as is. Returns {node}.',
    executionMode: 'sequential',
    schema: Type.Object({ space_path: spacePath('Folder path such as "/Project A/drafts".') }),
};
export const SpaceMoveToolDef = {
    name: SPACE_MOVE_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Move Space (资料空间) files or folders into another folder. The destination must exist. ' +
        'One item: give space_path or node_id; returns {node}. ' +
        'Several items into the same folder: give node_ids (up to 100); returns {to_folder, moved, moved_count} and, for the ones that failed, {failed, failed_count} — a failure never stops the rest. ' +
        'on_conflict decides what happens when the destination already has that name: fail (default), rename to the first free "name (N).ext", or overwrite.',
    executionMode: 'sequential',
    schema: Type.Object({
        space_path: itemPath,
        node_id: nodeIdField,
        node_ids: nodeIdsField,
        to_folder: spacePath('Existing destination folder, such as "/Archive"; "/" is the root.'),
        on_conflict: Type.Optional(Type.Union([Type.Literal('fail'), Type.Literal('rename'), Type.Literal('overwrite')], {
            description: 'When the destination already has that name. Default fail (NAME_CONFLICT).',
        })),
    }),
};
export const SpaceRenameToolDef = {
    name: SPACE_RENAME_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Rename a Space (资料空间) file or folder. A file keeps its extension. Returns {node}.',
    executionMode: 'sequential',
    schema: Type.Object({
        space_path: itemPath,
        node_id: nodeIdField,
        new_name: Type.String({ description: "New name without '/'." }),
    }),
};
export const SpaceDeleteToolDef = {
    name: SPACE_DELETE_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Delete Space (资料空间) files or folders permanently; there is no recycle bin and a deleted item cannot be restored. Two calls. ' +
        'Without confirm_token nothing is deleted: it returns status confirm_required, confirm_token, expires_at, node and affected {file_count, size_bytes}, which counts every Active file that would be deleted, at any depth under a folder; folders themselves are not counted. ' +
        'Check that preview, then call again with the same target and confirm_token (one-time, valid 30 minutes) to delete. ' +
        'Several items: give node_ids (up to 100) instead of a single target; one preview and one confirm_token cover the whole selection, a file under two selected folders counts once, and the preview returns items plus any failed entries. ' +
        'Published websites, and folders containing them, cannot be deleted here.',
    executionMode: 'sequential',
    schema: Type.Object({
        space_path: itemPath,
        node_id: nodeIdField,
        node_ids: nodeIdsField,
        confirm_token: Type.Optional(Type.String({ description: 'Token from the preview. Omit to preview.' })),
    }),
};
export const SpaceQuotaToolDef = {
    name: SPACE_QUOTA_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        "Show the user's Space (资料空间) storage: used_bytes, quota_bytes (0 = unlimited), available_bytes (-1 = unlimited), max_file_bytes.",
    schema: Type.Object({}),
};
export const SpaceDownloadUrlToolDef = {
    name: SPACE_DOWNLOAD_URL_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Sign a download URL for one Space (资料空间) file, for the user to open or download. ' +
        'This is the user path: the server picks the key by provenance and the user watermark setting and binds the file name. ' +
        'The URL is pre-signed and expires; expires_in_seconds is given when the server reports an expiry. ' +
        'A link returns {node, link} and signs nothing; a folder is rejected. ' +
        'Returns {node, download_url, expires_at, expires_in_seconds}.',
    schema: Type.Object({ space_path: itemPath, node_id: nodeIdField }),
};
export const SpaceFavoriteToolDef = {
    name: SPACE_FAVORITE_TOOL_NAME,
    loading: 'on_demand',
    description: SPACE_SKILL_REQUIRED +
        'Add or remove the favorite mark on up to 100 Space (资料空间) items. Idempotent per item. ' +
        'Returns {favorited, updated, updated_count} and, for the ones that failed, {failed, failed_count}.',
    executionMode: 'sequential',
    schema: Type.Object({
        node_ids: Type.Array(Type.String(), {
            minItems: 1,
            maxItems: 100,
            description: 'node_id of each item.',
        }),
        favorited: Type.Boolean({ description: 'true adds the mark, false removes it.' }),
    }),
};
export const SPACE_TOOL_DEFS = [
    SpaceListToolDef,
    SpaceStatToolDef,
    SpaceSearchToolDef,
    SpaceDownloadToolDef,
    SpaceDownloadUrlToolDef,
    SpaceUploadToolDef,
    SpaceMkdirToolDef,
    SpaceMoveToolDef,
    SpaceRenameToolDef,
    SpaceDeleteToolDef,
    SpaceFavoriteToolDef,
    SpaceQuotaToolDef,
];
/** The space_* tools on one drive backend; the host supplies paths and bookkeeping. */
export function buildSpaceTools(deps) {
    const context = (ctx, signal) => ({
        drive: deps.backend,
        sessionId: ctx.sessionId,
        fetchImpl: deps.fetchImpl ?? globalThis.fetch,
        resolveLocalPath: deps.resolveLocalPath,
        localFiles: deps.localFiles ?? nodeFsSpaceLocalFileAccess,
        confirmations: deps.confirmations ?? sharedSpaceDeleteConfirmations,
        ...(deps.hooks ? { hooks: deps.hooks } : {}),
        now: deps.now ?? Date.now,
        randomToken: deps.randomToken ?? (() => randomBytes(6).toString('hex')),
        ...(signal ? { signal } : {}),
    });
    const tool = (def, run) => defineRuntimeTool({
        ...def,
        prepareArguments: (args) => prepareSpaceArguments(def.schema, args),
        execute: async (ctx, input, signal) => {
            const gate = deps.skillGate;
            if (gate && !gate.loads.has(ctx.sessionId, gate.skillName)) {
                return spaceSkillRequiredResult(def.name, gate.skillName);
            }
            try {
                return spaceOk(def.name, await run(context(ctx, signal), input));
            }
            catch (error) {
                return spaceFailure(def.name, error);
            }
        },
    });
    // The batch shapes live here rather than in the operations, so a single-item call keeps the
    // exact argument and result types it always had.
    const move = (op, input) => {
        if (input.node_ids === undefined) {
            return moveSpace(op, {
                ...(input.space_path === undefined ? {} : { space_path: input.space_path }),
                ...(input.node_id === undefined ? {} : { node_id: input.node_id }),
                to_folder: input.to_folder,
                ...(input.on_conflict === undefined ? {} : { on_conflict: input.on_conflict }),
            });
        }
        // A single target next to node_ids would be silently dropped.
        if (input.space_path !== undefined || input.node_id !== undefined) {
            throw new SpaceError('INVALID_ARGS', 'Give node_ids for a batch, or space_path / node_id for one item, not both.');
        }
        return batchMoveSpace(op, {
            node_ids: input.node_ids,
            to_folder: input.to_folder,
            ...(input.on_conflict === undefined ? {} : { on_conflict: input.on_conflict }),
        });
    };
    const upload = (op, input) => {
        if (input.local_paths !== undefined) {
            if (input.local_path !== undefined ||
                input.name !== undefined ||
                input.node_id !== undefined ||
                input.expect_updated_at !== undefined) {
                throw new SpaceError('INVALID_ARGS', 'local_paths uploads several new files into one folder; it cannot be combined with local_path, name, node_id or expect_updated_at.');
            }
            if (input.to_folder === undefined) {
                throw new SpaceError('INVALID_ARGS', 'Give to_folder (use "/" for the Space root) with local_paths.');
            }
            return batchUploadSpace(op, {
                local_paths: input.local_paths,
                to_folder: input.to_folder,
                ...(input.on_conflict === undefined ? {} : { on_conflict: input.on_conflict }),
            });
        }
        if (input.local_path === undefined) {
            throw new SpaceError('INVALID_ARGS', 'Give local_path for one file, or local_paths for several.');
        }
        return uploadSpace(op, {
            local_path: input.local_path,
            ...(input.to_folder === undefined ? {} : { to_folder: input.to_folder }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.on_conflict === undefined ? {} : { on_conflict: input.on_conflict }),
            ...(input.node_id === undefined ? {} : { node_id: input.node_id }),
            ...(input.expect_updated_at === undefined
                ? {}
                : { expect_updated_at: input.expect_updated_at }),
        });
    };
    return [
        tool(SpaceListToolDef, listSpace),
        tool(SpaceStatToolDef, statSpace),
        tool(SpaceSearchToolDef, searchSpace),
        tool(SpaceDownloadToolDef, downloadSpace),
        tool(SpaceDownloadUrlToolDef, downloadUrlSpace),
        tool(SpaceUploadToolDef, upload),
        tool(SpaceMkdirToolDef, mkdirSpace),
        tool(SpaceMoveToolDef, move),
        tool(SpaceRenameToolDef, renameSpace),
        tool(SpaceDeleteToolDef, deleteSpace),
        tool(SpaceFavoriteToolDef, favoriteSpace),
        tool(SpaceQuotaToolDef, (op) => quotaSpace(op)),
    ];
}
/**
 * Runs before schema validation, also inside mcp_invoke. Its `arguments` are untyped,
 * so models send numbers and booleans as strings ("100", "1793849447682", "true").
 * Only those exact forms of top-level integer and boolean fields are converted;
 * anything else is left for validation to reject.
 */
function prepareSpaceArguments(schema, args) {
    if (args === null || typeof args !== 'object' || Array.isArray(args))
        return args;
    const properties = schema.properties ?? {};
    let prepared;
    for (const [key, value] of Object.entries(args)) {
        if (typeof value !== 'string' || !Object.hasOwn(properties, key))
            continue;
        const converted = convertScalarString(properties[key]?.type, value.trim());
        if (converted === undefined)
            continue;
        prepared ??= { ...args };
        prepared[key] = converted;
    }
    return prepared ?? args;
}
function convertScalarString(type, text) {
    if (type === 'integer' && /^-?\d+$/.test(text)) {
        const value = Number(text);
        return Number.isSafeInteger(value) ? value : undefined;
    }
    if (type === 'boolean' && (text === 'true' || text === 'false'))
        return text === 'true';
    return undefined;
}
/** One-line JSON so hosts can scan the result (Desktop links uploads to local files). */
function spaceOk(toolName, value) {
    const text = JSON.stringify({ ok: true, ...value });
    return { tool_name: toolName, text, content: [{ type: 'text', text }], details: { ok: true } };
}
/** Failures are results, never throws, so the model can read the code and recover. */
function spaceFailure(toolName, error) {
    const failure = toSpaceError(error);
    const text = JSON.stringify({
        ok: false,
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
    });
    return {
        tool_name: toolName,
        text,
        content: [{ type: 'text', text }],
        isError: true,
        details: { ok: false, code: failure.code },
    };
}
//# sourceMappingURL=tools.js.map