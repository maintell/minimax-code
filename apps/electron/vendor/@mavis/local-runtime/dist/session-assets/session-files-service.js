/**
 * Session-files domain facade.
 *
 * Owns serving the DesktopService `ListSessionFiles` contract from the
 * session asset index: legacy message migration, lazy index build, page
 * query, and mapping asset records into generated `DriveNode` views. Local
 * deliverables fill `path`; only drive-backed assets (commit-id transport)
 * fill `nodeId`. There is intentionally NO legacy `/mavis/api` route for
 * this endpoint — the product path is DesktopService only.
 *
 * Per the desktop-service ownership ADR the domain owns service creation,
 * caching, and lifecycle: the host installs the service via
 * `initSessionFilesService()` at construction, and `DesktopService` reaches
 * it through the process-scoped `getSessionFilesService()` accessor (failing
 * closed before a host exists).
 */
import { collectMessageAssetItems, isCommitIdTransportId, } from '@mavis/shared/asset-markup';
import { deriveMediaKind, inferAssetMimeType } from '@mavis/shared';
import { DriveNodeSource, DriveNodeType, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { DEFAULT_SESSION_ASSET_PAGE_SIZE, MAX_SESSION_ASSET_PAGE_SIZE, SqliteSessionAssetStore, } from './session-asset-store.js';
import { computeSessionAssetKey } from './session-asset-index.js';
function fileBasename(p) {
    const normalized = p.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    return idx < 0 ? normalized : normalized.slice(idx + 1);
}
function fileExtension(nameOrPath) {
    const base = fileBasename(nameOrPath.split('#')[0]?.split('?')[0] ?? nameOrPath);
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1)
        return '';
    return base.slice(dot + 1).toLowerCase();
}
const PPT_EXTENSIONS = new Set(['ppt', 'pptx', 'key']);
const EXCEL_EXTENSIONS = new Set(['xls', 'xlsx', 'csv', 'tsv']);
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'pdf', 'txt', 'md', 'markdown', 'html', 'htm']);
/**
 * Conservative category mapping onto the archon_biz vocabulary
 * (documents/excel/ppt/images/videos/audio/other + website). Unknown → ''.
 */
function deriveCategory(input) {
    const type = input.type?.trim().toLowerCase() ?? '';
    if (type === 'website')
        return 'website';
    const kind = deriveMediaKind({ type: input.type, name: input.name, path: input.path });
    if (kind === 'image')
        return 'images';
    if (kind === 'video')
        return 'videos';
    if (kind === 'audio')
        return 'audio';
    const ext = fileExtension(input.name || '') || fileExtension(input.path);
    if (PPT_EXTENSIONS.has(ext) || PPT_EXTENSIONS.has(type))
        return 'ppt';
    if (EXCEL_EXTENSIONS.has(ext) || EXCEL_EXTENSIONS.has(type))
        return 'excel';
    if (DOCUMENT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(type))
        return 'documents';
    return '';
}
export function toSessionAssetDriveNode(input) {
    const isDriveBacked = Boolean(input.driveNodeId) || isCommitIdTransportId(input.path);
    const name = input.name?.trim() || fileBasename(input.path);
    return {
        // Only real drive assets get a nodeId; local files are addressed by path.
        nodeId: isDriveBacked ? (input.driveNodeId ?? '') : '',
        nodeType: DriveNodeType.File,
        parentId: '',
        name,
        fileExt: fileExtension(input.name || '') || fileExtension(input.path),
        category: deriveCategory({ path: input.path, name: input.name, type: input.assetType }),
        mimeType: inferAssetMimeType({ path: input.path, name: input.name, type: input.assetType }) ?? '',
        // Local paths never get a fake CDN URL; drive-backed preview resolves
        // client-side through the drive service by nodeId.
        cdnUrl: '',
        source: DriveNodeSource.AgentDeliverable,
        sessionId: input.sessionId,
        createdAt: input.createdAtMs,
        updatedAt: input.createdAtMs,
        path: input.path,
    };
}
function normalizeLimit(limit) {
    if (!Number.isFinite(limit) || limit === undefined || limit <= 0) {
        return DEFAULT_SESSION_ASSET_PAGE_SIZE;
    }
    return Math.min(Math.floor(limit), MAX_SESSION_ASSET_PAGE_SIZE);
}
export class LocalSessionFilesService {
    deps;
    store;
    constructor(deps) {
        this.deps = deps;
        this.store = deps.sessionAssetStore;
    }
    /**
     * Serve one `ListSessionFiles` page. Unknown sessions yield an empty page
     * (the index simply has no rows) rather than an error, matching the
     * read-only, best-effort semantics of the Workspace panel.
     */
    async list(sessionId, opts) {
        const limit = normalizeLimit(opts?.limit);
        if (!this.deps.hasMessageStore && !this.store) {
            return this.listFromMemory(sessionId, limit);
        }
        await this.deps.ensureLegacyMessagesMigrated(sessionId);
        this.store ??= new SqliteSessionAssetStore(this.deps.dataDir());
        await this.store.ensureIndexed(sessionId);
        const page = await this.store.listAssets(sessionId, { limit, cursor: opts?.cursor });
        return {
            nodes: page.assets.map((asset) => this.mapAssetRecord(sessionId, asset)),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    mapAssetRecord(sessionId, asset) {
        return toSessionAssetDriveNode({
            sessionId,
            path: asset.path,
            name: asset.name,
            assetType: asset.assetType,
            driveNodeId: asset.driveNodeId,
            createdAtMs: asset.messageCreatedAtMs,
        });
    }
    /** In-memory fallback: newest-first latest-per-asset over live messages. */
    async listFromMemory(sessionId, limit) {
        const messages = await this.deps.getDisplayMessages(sessionId);
        const latestByKey = new Map();
        for (const message of messages) {
            if (message.role !== 'assistant' || typeof message.msg_content !== 'string')
                continue;
            const createdAtMs = typeof message.timestamp === 'number' ? message.timestamp : Date.now();
            for (const item of collectMessageAssetItems(message.msg_content)) {
                const key = computeSessionAssetKey(item);
                if (!key)
                    continue;
                latestByKey.set(key, { item, createdAtMs });
            }
        }
        const nodes = [...latestByKey.values()]
            .sort((a, b) => b.createdAtMs - a.createdAtMs)
            .slice(0, limit)
            .map(({ item, createdAtMs }) => toSessionAssetDriveNode({
            sessionId,
            path: item.path,
            name: item.name,
            assetType: item.type,
            driveNodeId: item.driveNodeId,
            createdAtMs,
        }));
        return { nodes, hasMore: false };
    }
}
// Process-scoped domain singleton (production runs one host per process; the
// host installs its service at construction, matching the ADR facade model).
let currentSessionFilesService;
/** Single production entry point for populating `getSessionFilesService()`. */
export function initSessionFilesService(deps) {
    currentSessionFilesService = new LocalSessionFilesService(deps);
    return currentSessionFilesService;
}
/** Fails closed before a host has installed the service. */
export function getSessionFilesService() {
    if (!currentSessionFilesService) {
        throw new Error('Local session-files service is not initialized');
    }
    return currentSessionFilesService;
}
//# sourceMappingURL=session-files-service.js.map