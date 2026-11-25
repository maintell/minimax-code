import { SessionFileSyncServiceError, } from './contracts.js';
import { isSessionAssetIndexCurrent } from './index-policy.js';
import { normalizeSha256, readLocalFileIdentity, sha256File } from './local-file.js';
export class SessionFilesService {
    options;
    nowMs;
    indexing = new Map();
    deleted = new Set();
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async querySessionFileSyncSources(input) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(offset) ||
            offset < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > 200 ||
            !validSourceNodeIds(input.nodeIds)) {
            throw new SessionFileSyncServiceError('invalid-input', 'Invalid file sync source query');
        }
        if (input.nodeIds?.length === 0)
            return { sources: [], hasMore: false };
        const rows = await this.options.fileSyncs.querySources({ ...input, offset, limit: limit + 1 });
        return { sources: rows.slice(0, limit), hasMore: rows.length > limit };
    }
    async invalidateSessionFileSyncSources(sources) {
        if (sources.length > 200 ||
            sources.some((s) => !s.sessionId.trim() ||
                !s.path.trim() ||
                !s.nodeId.trim() ||
                !Number.isSafeInteger(s.updatedAtMs) ||
                s.updatedAtMs < 0 ||
                !normalizeSha256(s.sha256))) {
            throw new SessionFileSyncServiceError('invalid-input', 'Invalid file sync source snapshot');
        }
        return this.options.fileSyncs.invalidateSources(sources);
    }
    async bindSessionFileSyncOwner(sources, accountId) {
        if (!/^\d+$/.test(accountId) ||
            sources.length > 200 ||
            sources.some((s) => !s.nodeId || !s.path || !s.sessionId || !Number.isSafeInteger(s.updatedAtMs)))
            throw new SessionFileSyncServiceError('invalid-input', 'Invalid file sync owner binding');
        await this.options.fileSyncs.bindOwner(sources, accountId);
    }
    async listSessionFiles(input) {
        await this.ensureSessionFilesReady(input.sessionId);
        if (!(await this.isQueryable(input.sessionId)))
            return emptyPage();
        const page = await this.options.assets.listPage(input);
        return {
            files: page.assets.map(toSessionFileAsset),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }
    async ensureSessionFilesReady(sessionId) {
        if (!(await this.isQueryable(sessionId)))
            return;
        await this.ensureIndexed(sessionId);
    }
    async deleteSession(sessionId) {
        this.deleted.add(sessionId);
        const activeIndex = this.indexing.get(sessionId);
        if (activeIndex) {
            try {
                await activeIndex;
            }
            catch {
                // A failed rebuild must not prevent idempotent Session cleanup.
            }
        }
        await this.options.assets.deleteSession(sessionId);
        await this.options.fileSyncs.deleteSession(sessionId);
    }
    /**
     * Sync state of the requested files. A path is omitted when it is not an absolute path to an
     * existing file or was never uploaded from this Session. Unchanged size and mtime skip hashing.
     */
    async getSessionFileSyncs(input) {
        if (input.paths.length === 0 || !(await this.isQueryable(input.sessionId)))
            return [];
        const files = new Map();
        for (const path of new Set(input.paths)) {
            const identity = await readLocalFileIdentity(path);
            if (identity)
                files.set(path, identity);
        }
        const records = await this.options.fileSyncs.getByPaths(input.sessionId, [...files.values()].map((file) => file.realPath));
        const byRealPath = new Map(records.map((record) => [record.path, record]));
        const states = [];
        for (const [path, file] of files) {
            const record = byRealPath.get(file.realPath);
            if (!record)
                continue;
            const modified = await this.isModified(input.sessionId, record, file);
            if (modified === undefined)
                continue;
            states.push({
                path,
                nodeId: record.nodeId,
                ...(record.drivePath ? { drivePath: record.drivePath } : {}),
                modified,
            });
        }
        return states;
    }
    /**
     * Records that `path` was uploaded as `nodeId` with content `sha256`, replacing any earlier
     * record for the same real path. When the file already differs from `sha256` the record is
     * kept but reported (and later read) as modified.
     */
    async recordSessionFileSync(input) {
        const { nodeId, sha256, drivePath } = normalizeFileSyncRecord(input);
        validateSyncAccount(input.accountId);
        if (!(await this.isQueryable(input.sessionId))) {
            throw new SessionFileSyncServiceError('session-not-found', 'Session not found');
        }
        const file = await readLocalFileIdentity(input.path);
        const current = file ? await sha256File(file.realPath) : undefined;
        if (!file || current === undefined) {
            throw new SessionFileSyncServiceError('file-not-found', 'Local file not found');
        }
        const matches = current === sha256;
        await this.options.fileSyncs.upsert({
            sessionId: input.sessionId,
            path: file.realPath,
            nodeId,
            sha256,
            size: matches ? file.size : -1,
            mtimeMs: matches ? file.mtimeMs : -1,
            drivePath,
            accountId: input.accountId ?? null,
            updatedAtMs: this.nowMs(),
        });
        return { path: input.path, nodeId, ...(drivePath ? { drivePath } : {}), modified: !matches };
    }
    /** Undefined when the file vanished while hashing. */
    async isModified(sessionId, record, file) {
        if (record.size === file.size && record.mtimeMs === file.mtimeMs)
            return false;
        const current = await sha256File(file.realPath);
        if (current === undefined)
            return undefined;
        if (current !== record.sha256)
            return true;
        await this.options.fileSyncs.updateStat({
            sessionId,
            path: record.path,
            sha256: record.sha256,
            size: file.size,
            mtimeMs: file.mtimeMs,
        });
        return false;
    }
    async ensureIndexed(sessionId) {
        const current = this.indexing.get(sessionId);
        if (current)
            return current;
        const operation = this.runIndex(sessionId);
        this.indexing.set(sessionId, operation);
        return operation;
    }
    async runIndex(sessionId) {
        try {
            await this.buildIndex(sessionId);
        }
        finally {
            this.indexing.delete(sessionId);
        }
    }
    async buildIndex(sessionId) {
        if (!(await this.isQueryable(sessionId)))
            return;
        const latestRowId = await this.options.messages.latestDisplayRowId(sessionId);
        if (!(await this.isQueryable(sessionId)))
            return;
        const state = await this.options.assets.getIndexState(sessionId);
        if (isSessionAssetIndexCurrent(state, latestRowId))
            return;
        await this.options.assets.rebuild(sessionId, this.nowMs());
    }
    async isQueryable(sessionId) {
        return !this.deleted.has(sessionId) && (await this.options.sessions.has(sessionId));
    }
}
function validSourceNodeIds(ids) {
    return ids === undefined || (ids.length <= 200 && ids.every((id) => Boolean(id.trim())));
}
function validateSyncAccount(accountId) {
    if (accountId !== undefined && !/^\d+$/.test(accountId))
        throw new SessionFileSyncServiceError('invalid-input', 'Invalid cloud owner');
}
function emptyPage() {
    return { files: [], hasMore: false };
}
function normalizeFileSyncRecord(input) {
    const nodeId = input.nodeId.trim();
    const sha256 = normalizeSha256(input.sha256);
    if (!nodeId || !sha256) {
        throw new SessionFileSyncServiceError('invalid-input', 'node_id and a sha256 hex digest are required');
    }
    return { nodeId, sha256, drivePath: input.drivePath?.trim() || null };
}
function toSessionFileAsset(asset) {
    return {
        messageId: asset.messageId,
        messageCreatedAtMs: asset.messageCreatedAtMs,
        assetKey: asset.assetKey,
        sourceTag: asset.sourceTag,
        path: asset.path,
        name: asset.name,
        assetType: asset.assetType,
        dataJson: asset.dataJson,
    };
}
//# sourceMappingURL=service.js.map