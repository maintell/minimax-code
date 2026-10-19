import { isSessionAssetIndexCurrent } from './index-policy.js';
export class SessionFilesService {
    options;
    nowMs;
    indexing = new Map();
    deleted = new Set();
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
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
function emptyPage() {
    return { files: [], hasMore: false };
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