export class WorkspaceSemanticIndexCache {
    maxEntries;
    entries = new Map();
    constructor(maxEntries) {
        this.maxEntries = maxEntries;
        if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
            throw new Error(`invalid_workspace_semantic_index_cache_size:${maxEntries}`);
        }
    }
    async getOrLoad(input, load) {
        const key = cacheKey(input);
        const existing = this.entries.get(key);
        if (existing) {
            this.touch(key, existing);
            return existing.value;
        }
        const value = load();
        const entry = {
            workspaceId: input.workspaceId,
            revisionId: input.revisionId,
            value,
        };
        this.entries.set(key, entry);
        this.evictOverflow();
        try {
            return await value;
        }
        catch (error) {
            if (this.entries.get(key) === entry)
                this.entries.delete(key);
            throw error;
        }
    }
    put(input, index) {
        const key = cacheKey(input);
        this.entries.delete(key);
        this.entries.set(key, {
            workspaceId: input.workspaceId,
            revisionId: input.revisionId,
            value: Promise.resolve(index),
        });
        this.evictOverflow();
    }
    deleteRevisions(workspaceId, revisionIds) {
        for (const [key, entry] of this.entries) {
            if (entry.workspaceId === workspaceId && revisionIds.has(entry.revisionId)) {
                this.entries.delete(key);
            }
        }
    }
    touch(key, entry) {
        this.entries.delete(key);
        this.entries.set(key, entry);
    }
    evictOverflow() {
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                return;
            this.entries.delete(oldest);
        }
    }
}
function cacheKey(input) {
    return JSON.stringify([
        input.workspaceId,
        input.revisionId,
        input.rootHash,
        input.archiveSha256,
        input.archiveSizeBytes,
        input.embeddingModel,
        input.dimensions,
        input.normalization,
    ]);
}
//# sourceMappingURL=semantic-index-cache.js.map