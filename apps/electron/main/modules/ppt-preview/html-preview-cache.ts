import { rmSync } from "fs";
import { access, rm } from "fs/promises";
import path from "path";
const DEFAULT_MAX_ENTRIES = 10;
function resolveOptionalPath(value) {
    return value ? path.resolve(value) : null;
}
function buildKeepSet(options) {
    const keepPaths = new Set();
    const single = resolveOptionalPath(options?.keepProcessedHtmlPath);
    if (single)
        keepPaths.add(single);
    for (const keepPath of options?.keepProcessedHtmlPaths ?? []) {
        const resolved = resolveOptionalPath(keepPath);
        if (resolved)
            keepPaths.add(resolved);
    }
    return keepPaths;
}
export class HtmlPreviewCache {
    constructor(options = {}) {
        this.entries = new Map();
        this.deferredTmpDirs = new Map();
        this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
        this.now = options.now ?? Date.now;
    }
    get size() {
        return this.entries.size;
    }
    async lookup(filePath, stat, processorVersion, keepOptions) {
        const entry = this.entries.get(filePath);
        if (!entry)
            return { hit: false, reason: 'miss:no-entry' };
        if (entry.mtimeMs !== stat.mtimeMs) {
            await this.removeEntry(filePath, keepOptions);
            return { hit: false, reason: 'miss:mtime-changed' };
        }
        if (entry.size !== stat.size) {
            await this.removeEntry(filePath, keepOptions);
            return { hit: false, reason: 'miss:size-changed' };
        }
        if (entry.processorVersion !== processorVersion) {
            await this.removeEntry(filePath, keepOptions);
            return { hit: false, reason: 'miss:processor-version' };
        }
        try {
            await access(entry.processedHtmlPath);
            if (entry.rasterHtmlPath) {
                await access(entry.rasterHtmlPath);
            }
            for (const image of entry.slideImages ?? []) {
                await access(image.imagePath);
            }
        }
        catch (error) {
            await this.removeEntry(filePath, keepOptions);
            return {
                hit: false,
                reason: 'miss:cached-file-missing',
                error: String(error),
            };
        }
        entry.lastUsedMs = this.now();
        return { hit: true, entry };
    }
    async put(input, keepOptions) {
        const previous = this.entries.get(input.filePath);
        const keepPaths = buildKeepSet({
            ...keepOptions,
            keepProcessedHtmlPaths: [
                ...(keepOptions?.keepProcessedHtmlPaths ?? []),
                keepOptions?.keepProcessedHtmlPath,
                input.processedHtmlPath,
            ],
        });
        if (previous) {
            this.entries.delete(input.filePath);
            await this.cleanupEntry(previous, keepPaths);
        }
        this.entries.set(input.filePath, {
            ...input,
            tmpDir: input.tmpDir ? path.resolve(input.tmpDir) : null,
            processedHtmlPath: path.resolve(input.processedHtmlPath),
            rasterHtmlPath: input.rasterHtmlPath ? path.resolve(input.rasterHtmlPath) : undefined,
            slideImages: input.slideImages?.map((image) => ({
                ...image,
                imagePath: path.resolve(image.imagePath),
            })),
            lastUsedMs: this.now(),
        });
        await this.cleanupDeferredTmpDirs(keepPaths);
        await this.prune({
            ...keepOptions,
            keepProcessedHtmlPaths: [
                ...(keepOptions?.keepProcessedHtmlPaths ?? []),
                keepOptions?.keepProcessedHtmlPath,
                input.processedHtmlPath,
            ],
        });
    }
    async delete(filePath, keepOptions) {
        await this.removeEntry(filePath, keepOptions);
    }
    async prune(keepOptions) {
        const keepPaths = buildKeepSet(keepOptions);
        await this.cleanupDeferredTmpDirs(keepPaths);
        if (this.entries.size <= this.maxEntries)
            return;
        const oldestFirst = [...this.entries.entries()].sort(([, a], [, b]) => a.lastUsedMs - b.lastUsedMs);
        for (const [filePath, entry] of oldestFirst) {
            if (this.entries.size <= this.maxEntries)
                break;
            if (keepPaths.has(path.resolve(entry.processedHtmlPath)))
                continue;
            this.entries.delete(filePath);
            await this.cleanupEntry(entry, keepPaths);
        }
    }
    async clear(keepOptions) {
        const keepPaths = buildKeepSet(keepOptions);
        for (const [filePath, entry] of [...this.entries.entries()]) {
            if (keepPaths.has(path.resolve(entry.processedHtmlPath)))
                continue;
            this.entries.delete(filePath);
            await this.cleanupEntry(entry, keepPaths);
        }
        await this.cleanupDeferredTmpDirs(keepPaths);
    }
    clearSync() {
        for (const entry of this.entries.values()) {
            this.cleanupEntrySync(entry);
        }
        this.entries.clear();
        for (const tmpDir of this.deferredTmpDirs.keys()) {
            rmSync(tmpDir, { recursive: true, force: true });
        }
        this.deferredTmpDirs.clear();
    }
    async removeEntry(filePath, keepOptions) {
        const entry = this.entries.get(filePath);
        if (!entry)
            return;
        this.entries.delete(filePath);
        await this.cleanupEntry(entry, buildKeepSet(keepOptions));
    }
    async cleanupEntry(entry, keepPaths) {
        const tmpDir = entry.tmpDir ? path.resolve(entry.tmpDir) : null;
        if (!tmpDir)
            return;
        const processedHtmlPath = path.resolve(entry.processedHtmlPath);
        if (keepPaths.has(processedHtmlPath)) {
            this.deferredTmpDirs.set(tmpDir, processedHtmlPath);
            return;
        }
        await rm(tmpDir, { recursive: true, force: true });
        this.deferredTmpDirs.delete(tmpDir);
    }
    cleanupEntrySync(entry) {
        if (!entry.tmpDir)
            return;
        rmSync(entry.tmpDir, { recursive: true, force: true });
    }
    async cleanupDeferredTmpDirs(keepPaths) {
        for (const [tmpDir, processedHtmlPath] of [...this.deferredTmpDirs.entries()]) {
            if (keepPaths.has(path.resolve(processedHtmlPath)))
                continue;
            await rm(tmpDir, { recursive: true, force: true });
            this.deferredTmpDirs.delete(tmpDir);
        }
    }
}

export let pptHtmlPreviewCache = new HtmlPreviewCache();
