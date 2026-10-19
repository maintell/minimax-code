/**
 * Message-level asset collection helpers.
 *
 * Extracted from the UI's `WorkspacePanel/workspace-collector.ts` so the
 * local-runtime session asset indexer and the UI Workspace collector share
 * the same wrapper extraction, path filtering, normalization, and dedupe
 * semantics. Keep behavior in sync with the UI collector tests.
 */
import { isBlobUrl, isHttpUrl, maskMarkdownProtectedRanges, parseDeliverAssetsContent, } from './deliver-assets.js';
import { isDataUrl } from './data-url.js';
const DELIVER_ASSETS_WRAPPER_RE = /<(deliver-assets|deliver_assets)>([\s\S]*?)<\/\1>/g;
/** Strip line number suffix (:42) from a file path. */
function stripLineNumber(p) {
    return p.replace(/:\d+$/, '');
}
export function extractDeliverAssetsWrappers(content) {
    const wrappers = [];
    DELIVER_ASSETS_WRAPPER_RE.lastIndex = 0;
    let match;
    while ((match = DELIVER_ASSETS_WRAPPER_RE.exec(content)) !== null) {
        wrappers.push(match[0]);
    }
    return wrappers.join('\n');
}
export function stripDeliverAssetsWrappers(content) {
    DELIVER_ASSETS_WRAPPER_RE.lastIndex = 0;
    return content.replace(DELIVER_ASSETS_WRAPPER_RE, '');
}
/**
 * Normalize a path into the dedupe key used by Workspace and the session
 * asset index: strip `:line`, unify separators, drop trailing slashes, and
 * lowercase Windows drive letters.
 */
export function normalizeAssetPathKey(path) {
    const trimmed = stripLineNumber(path.trim()).replace(/\\/g, '/');
    const withoutTrailingSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/u, '') : trimmed;
    return /^[A-Z]:\//u.test(withoutTrailingSlash)
        ? withoutTrailingSlash[0].toLowerCase() + withoutTrailingSlash.slice(1)
        : withoutTrailingSlash;
}
/** Remote URLs, virtual URLs, and app API paths never enter the workspace. */
export function shouldSkipAssetPath(path) {
    const trimmed = path.trim();
    return (isDataUrl(trimmed) ||
        isHttpUrl(trimmed) ||
        isBlobUrl(trimmed) ||
        /^\/(?:mavis\/api|api)\//u.test(trimmed));
}
/** Prefer entries carrying more metadata (name/type) on dedupe collisions. */
export function hasRicherAssetMetadata(a, b) {
    const aScore = (a.name ? 1 : 0) + (a.type ? 1 : 0) + (a.nodeId ? 1 : 0) + (a.coverPath ? 1 : 0);
    const bScore = (b.name ? 1 : 0) + (b.type ? 1 : 0) + (b.nodeId ? 1 : 0) + (b.coverPath ? 1 : 0);
    return aScore > bScore;
}
/** Add item to map keyed by normalized path, preferring richer metadata. */
export function addAssetItemToMap(map, item) {
    if (shouldSkipAssetPath(item.path))
        return;
    const key = normalizeAssetPathKey(item.path);
    const existing = map.get(key);
    const normalizedItem = item.path === key ? item : { ...item, path: key };
    if (!existing || hasRicherAssetMetadata(item, existing)) {
        map.set(key, normalizedItem);
    }
}
function collectFromAssetMarkup(map, content, options) {
    const segments = parseDeliverAssetsContent(content, options);
    for (const seg of segments) {
        if (seg.type === 'deliver-assets' || seg.type === 'image-gallery') {
            for (const item of seg.items)
                addAssetItemToMap(map, item);
        }
    }
}
/**
 * Collect asset items from one complete assistant message body.
 *
 * Sources match the UI Workspace collector:
 *  1. `<deliver-assets>` / `<deliver_assets>` wrapper blocks (always)
 *  2. standalone `<media />` tags (when `includeStandaloneMedia`, default on)
 *
 * Plain-text paths, inline-code paths, and code-fence content are ignored;
 * remote/virtual URLs and app API paths are filtered; results are deduped by
 * normalized path with richer metadata winning. Order follows first
 * appearance in the message.
 */
export function collectMessageAssetItems(msgContent, options = {}) {
    const { includeStandaloneMedia = true, ...parseOptions } = options;
    const byPath = new Map();
    // Mask code fences / inline code before wrapper extraction so fenced
    // example markup never indexes. (The UI collector extracts wrappers from
    // the raw content for streaming display; the persisted index is stricter.)
    const searchableContent = maskMarkdownProtectedRanges(msgContent);
    const workspaceMarkup = extractDeliverAssetsWrappers(searchableContent);
    if (workspaceMarkup) {
        collectFromAssetMarkup(byPath, workspaceMarkup, parseOptions);
    }
    if (includeStandaloneMedia) {
        const standaloneMarkup = stripDeliverAssetsWrappers(searchableContent);
        if (standaloneMarkup.trim()) {
            collectFromAssetMarkup(byPath, standaloneMarkup, parseOptions);
        }
    }
    return [...byPath.values()];
}
//# sourceMappingURL=message-assets.js.map