import { logger } from '../common/logger.js';
/** Session-scoped cache hydrated from that session's snapshot + ledger tail. */
export class LocalFileApiUploadStoreRegistry {
    options;
    stores = new Map();
    entries = new Map();
    loads = new Map();
    nowMs;
    constructor(options) {
        this.options = options;
        this.nowMs = options.nowMs ?? Date.now;
    }
    async forSession(sessionId) {
        await this.ensureHydrated(sessionId);
        const existing = this.stores.get(sessionId);
        if (existing)
            return existing;
        const entries = this.entries.get(sessionId) ?? new Map();
        this.entries.set(sessionId, entries);
        const store = {
            get: (cacheKey) => {
                const entry = entries.get(cacheKey);
                if (entry?.expiresAtMs && entry.expiresAtMs > this.nowMs()) {
                    return { fileId: entry.fileId, expiresAtMs: entry.expiresAtMs };
                }
                if (entry)
                    entries.delete(cacheKey);
                return undefined;
            },
            set: async (cacheKey, entry, record) => {
                entries.set(cacheKey, entry);
                await this.options.sessionWriter.recordFileApiUploaded(sessionId, record);
            },
        };
        this.stores.set(sessionId, store);
        return store;
    }
    deleteSession(sessionId) {
        this.stores.delete(sessionId);
        this.loads.delete(sessionId);
        this.entries.delete(sessionId);
    }
    async ensureHydrated(sessionId) {
        if (!this.options.ledgerStore || !this.options.snapshotStore)
            return;
        let load = this.loads.get(sessionId);
        if (!load) {
            load = this.loadSessionProjection(sessionId);
            this.loads.set(sessionId, load);
        }
        await load;
    }
    async loadSessionProjection(sessionId) {
        try {
            const resume = await this.options.snapshotStore.readResumeProjection(sessionId, this.options.ledgerStore);
            const entries = new Map();
            for (const [cacheKey, entry] of Object.entries(resume.projection.fileApiUploads ?? {})) {
                if (entry.expiresAtMs <= this.nowMs())
                    continue;
                entries.set(cacheKey, {
                    fileId: entry.fileId,
                    expiresAtMs: entry.expiresAtMs,
                });
            }
            this.entries.set(sessionId, entries);
        }
        catch (error) {
            this.logRestoreFailure(sessionId, error);
            this.entries.set(sessionId, new Map());
        }
    }
    logRestoreFailure(sessionId, error) {
        logger.warn({
            ...(sessionId ? { session_id: sessionId } : {}),
            error_type: error instanceof Error ? error.name : typeof error,
        }, '[messages-file-api] upload cache restore failed; starting with an empty cache');
    }
}
//# sourceMappingURL=file-api-upload-store.js.map