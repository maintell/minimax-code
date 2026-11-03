import { access } from 'node:fs/promises';
import { CanonicalHistoryJsonlDataSource } from '../../../../infra/file/canonical-history.js';
/**
 * Decoded history kept across reads, summed over every Session this adapter serves. The budget
 * counts file bytes; line-by-line decoding keeps the records at about 1.1x that on real histories.
 */
const DEFAULT_DECODED_HISTORY_CACHE_BYTES = 256 * 1024 * 1024;
/** Bounds bookkeeping for Sessions whose history is tiny or was never read. */
const MAX_CACHED_HISTORY_FILES = 256;
export function createCanonicalHistoryFileAdapter(options = {}) {
    return new JsonlCanonicalHistoryFileAdapter(options);
}
class JsonlCanonicalHistoryFileAdapter {
    options;
    /** Insertion order is recency order: every access moves the file to the end. */
    cachedSources = new Map();
    constructor(options) {
        this.options = options;
    }
    async targetExists(path) {
        return exists(path);
    }
    async readTarget(path) {
        if (!(await exists(path)))
            return undefined;
        return this.source(path).readActive();
    }
    async readTargetStrict(path) {
        if (!(await exists(path)))
            return undefined;
        return this.cachedRead(path, (source) => source.readActiveStrict());
    }
    async readActive(path) {
        return this.source(path).readActive();
    }
    async readActiveStrict(path) {
        return this.cachedRead(path, (source) => source.readActiveStrict());
    }
    async readEnvelopesStrict(path) {
        return this.cachedRead(path, (source) => source.readEnvelopesStrict());
    }
    async readStrict(path) {
        return this.source(path).readStrict();
    }
    async publishInitial(path, records) {
        return this.source(path).publishInitial(records);
    }
    async append(path, records, verifiedActive) {
        await this.source(path).append(records, verifiedActive);
    }
    async replace(path, records) {
        await this.source(path).replace(records);
    }
    async replaceActive(path, records) {
        await this.source(path).replaceActive(records);
    }
    async publishSnapshot(snapshotPath, records) {
        // Snapshots are written once and never read through the cache.
        return this.createSource(snapshotPath).publishSnapshot(snapshotPath, records);
    }
    forget(path) {
        this.cachedSources.delete(path);
    }
    async cachedRead(path, read) {
        try {
            return await read(this.source(path));
        }
        finally {
            this.trimCachedSources(path);
        }
    }
    source(path) {
        if (!this.options.reuseDecodedRecords)
            return this.createSource(path);
        const cached = this.cachedSources.get(path) ?? this.createSource(path);
        this.cachedSources.delete(path);
        this.cachedSources.set(path, cached);
        return cached;
    }
    createSource(path) {
        return new CanonicalHistoryJsonlDataSource({
            activePath: path,
            reuseDecodedRecords: this.options.reuseDecodedRecords,
            ...(this.options.onMalformedLine ? { onMalformedLine: this.options.onMalformedLine } : {}),
        });
    }
    /** Drops least recently read files until the decoded records fit the budget. */
    trimCachedSources(keepPath) {
        const budget = this.options.decodedCacheBytes ?? DEFAULT_DECODED_HISTORY_CACHE_BYTES;
        let total = 0;
        for (const source of this.cachedSources.values())
            total += source.cachedBytes();
        for (const [path, source] of this.cachedSources) {
            if (total <= budget && this.cachedSources.size <= MAX_CACHED_HISTORY_FILES)
                return;
            if (path === keepPath)
                continue;
            total -= source.cachedBytes();
            this.cachedSources.delete(path);
        }
    }
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw error;
    }
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
//# sourceMappingURL=canonical-history.js.map