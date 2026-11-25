/**
 * Agent-side Space (Drive) conventions shared by Cloud Runtime, Local Runtime
 * v2 and the UI: the default folder of a session, the Space reference line
 * shown with an attachment, and which node ids are Space items.
 */
const MAX_FOLDER_NAME_BYTES = 255;
// `/` and C0 control characters plus DEL cannot appear in a Drive node name.
// eslint-disable-next-line no-control-regex
const INVALID_FOLDER_NAME_CHARS = /[/\u0000-\u001F\u007F]/gu;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/gu;
const LEGACY_NODE_PREFIX = 'cs_';
/**
 * MIME of a Space link (category `link`) sent as an attachment. A link has no content, only its
 * url, which the agent reads with `space_stat` (`link`) and the UI resolves when it is opened.
 */
export const SPACE_LINK_MIME = 'text/uri-list';
/** Whether an attachment MIME marks a Space link. */
export function isSpaceLinkMime(mimeType) {
    return mimeType?.split(';', 1)[0]?.trim().toLowerCase() === SPACE_LINK_MIME;
}
/**
 * Folder name used for a project in the asset library, or `undefined` when the
 * project name cannot name a folder and the session counts as "not in a project".
 *
 * 1. Trim surrounding whitespace.
 * 2. Replace `/` and control characters with `_`.
 * 3. Truncate by character to at most 255 UTF-8 bytes.
 * 4. Empty, `.` and `..` are rejected.
 */
export function assetFolderName(projectName) {
    const replaced = (projectName ?? '').trim().replace(INVALID_FOLDER_NAME_CHARS, '_');
    const name = truncateUtf8(replaced, MAX_FOLDER_NAME_BYTES);
    if (name === '' || name === '.' || name === '..')
        return undefined;
    return name;
}
/** Default asset folder of a session: `/{assetFolderName(projectName)}/`, or `/`. */
export function assetDefaultFolder(projectName) {
    const folder = assetFolderName(projectName);
    return folder ? `/${folder}/` : '/';
}
/**
 * Whether a Drive node id names a history item of the classic library (`cs_`
 * ids). History items are not assets: attachments of them keep the plain
 * attachment behavior (a local copy, no reference line).
 */
export function isLegacyAssetNodeId(nodeId) {
    return nodeId.trim().startsWith(LEGACY_NODE_PREFIX);
}
/**
 * Space reference line, for example
 * `[space:/项目A/报告.docx] node_id=73861 type=file size=1.2MB`.
 *
 * Space attachments are passed by reference only: there is no local copy, the
 * agent downloads what it needs with `space_download`. The line carries no
 * version: the agent reads `node.updated_at` from `space_stat` or
 * `space_download` right before editing the file. Folders get a trailing
 * `/` and never carry size; a link (`type=link`) has no content and carries no
 * size either: its url comes from `space_stat`.
 */
export function formatAssetReference(input) {
    const isFolder = input.type === 'folder';
    const parts = [
        `[space:${referencePath(input.path, isFolder)}]`,
        `node_id=${singleLine(input.nodeId)}`,
        `type=${input.type}`,
    ];
    if (!isFolder && input.type !== 'link' && isNonNegativeNumber(input.sizeBytes)) {
        parts.push(`size=${formatAssetSize(input.sizeBytes)}`);
    }
    return parts.join(' ');
}
/** Human readable size used in the reference line: `512B`, `1.2MB`, `850MB`. */
export function formatAssetSize(sizeBytes) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, sizeBytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    if (unit === 0)
        return `${String(Math.round(value))}B`;
    const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
    return `${String(rounded)}${units[unit]}`;
}
// Paths may contain spaces and `]`, so the path ends at the first `] node_id=`.
const ASSET_REFERENCE_RE = /\[space:([^\n]*?)\] node_id=([^\s\]]+) type=(file|image|folder|link)(?: size=(\d+(?:\.\d+)?(?:B|KB|MB|GB|TB)))?/gu;
/**
 * Space reference lines in `text`, in order: the inverse of
 * {@link formatAssetReference}. A composer Space mention is sent as this line,
 * so the UI reads it back to show the mention again.
 */
export function parseAssetReferences(text) {
    const references = [];
    for (const match of text.matchAll(ASSET_REFERENCE_RE)) {
        const path = match[1] ?? '';
        references.push({
            index: match.index ?? 0,
            raw: match[0],
            nodeId: match[2] ?? '',
            ...(path.startsWith('/') ? { path } : {}),
            type: match[3],
            ...(match[4] ? { size: match[4] } : {}),
        });
    }
    return references;
}
/** Display name of a referenced item: the last path segment, or `undefined` without a path. */
export function assetReferenceName(path) {
    const segments = (path ?? '').split('/').filter(Boolean);
    return segments.at(-1);
}
function referencePath(path, isFolder) {
    const value = singleLine(path?.trim() ?? '');
    if (!value.startsWith('/'))
        return '?';
    return isFolder && !value.endsWith('/') ? `${value}/` : value;
}
function singleLine(value) {
    return value.replace(CONTROL_CHARS, ' ');
}
function isNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function truncateUtf8(value, maxBytes) {
    const encoder = new TextEncoder();
    if (encoder.encode(value).length <= maxBytes)
        return value;
    let bytes = 0;
    let result = '';
    for (const char of value) {
        const size = encoder.encode(char).length;
        if (bytes + size > maxBytes)
            break;
        bytes += size;
        result += char;
    }
    return result;
}
//# sourceMappingURL=drive-assets.js.map