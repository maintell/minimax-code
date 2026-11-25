import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
/** Largest Space presentation staged for a read-only preview (same cap as SSH staging). */
export let MAX_SPACE_PREVIEW_BYTES = 64 * 1024 * 1024;
/** Only presentations need a main-owned file; other formats preview from renderer bytes. */
export let SPACE_PREVIEW_EXTENSIONS = ['pptx'];
/**
 * Main-owned temporary copies of Space files opened in the read-only presentation preview.
 *
 * The preview pipeline (workspace authority, sanitizer, PPTX Core source stream) is path
 * based, so a cloud file becomes previewable as an exact local file. Every copy lives in its
 * own private directory and is removed when the preview releases it, when its renderer goes
 * away, or on shutdown.
 */
export class SpacePreviewStaging {
    constructor(options) {
        this.options = options;
        this.bySender = new Map();
        this.epochs = new Map();
        this.disposed = false;
    }
    async stage(input) {
        if (this.disposed || input.signal?.aborted)
            return null;
        const epoch = this.epochs.get(input.senderId) ?? 0;
        const current = () => !this.disposed && !input.signal?.aborted && (this.epochs.get(input.senderId) ?? 0) === epoch;
        const directory = await (this.options.createStagingDir ?? defaultStagingDir)();
        if (!current()) {
            await this.remove(directory);
            return null;
        }
        let owned = this.bySender.get(input.senderId);
        if (!owned) {
            owned = new Set();
            this.bySender.set(input.senderId, owned);
        }
        // Track before downloading so releaseSender also removes an in-flight copy.
        owned.add(directory);
        let downloaded = null;
        try {
            downloaded = await this.options.download({
                nodeId: input.nodeId,
                directory,
                extensions: SPACE_PREVIEW_EXTENSIONS,
                maxBytes: MAX_SPACE_PREVIEW_BYTES,
                signal: input.signal,
            });
        }
        catch {
            downloaded = null;
        }
        if (!downloaded || !current() || 'failureCode' in downloaded) {
            await this.releaseDirectory(input.senderId, directory);
            return downloaded && current() && 'failureCode' in downloaded ? downloaded : null;
        }
        let released = false;
        return {
            directory,
            filePath: path.join(directory, downloaded.fileName),
            release: async () => {
                if (released)
                    return;
                released = true;
                await this.releaseDirectory(input.senderId, directory);
            },
        };
    }
    /** Drop every copy of a destroyed renderer, including downloads still in flight. */
    async releaseSender(senderId) {
        this.epochs.set(senderId, (this.epochs.get(senderId) ?? 0) + 1);
        const owned = this.bySender.get(senderId);
        this.bySender.delete(senderId);
        await Promise.all([...(owned ?? [])].map((directory) => this.remove(directory)));
    }
    async dispose() {
        this.disposed = true;
        const senders = [...this.bySender.keys()];
        await Promise.all(senders.map((senderId) => this.releaseSender(senderId)));
    }
    async releaseDirectory(senderId, directory) {
        this.bySender.get(senderId)?.delete(directory);
        await this.remove(directory);
    }
    async remove(directory) {
        try {
            await rm(directory, { recursive: true, force: true });
        }
        catch (error) {
            this.options.onCleanupError?.(error);
        }
    }
}

function defaultStagingDir() {
    return mkdtemp(path.join(tmpdir(), 'mcode-space-preview-'));
}
