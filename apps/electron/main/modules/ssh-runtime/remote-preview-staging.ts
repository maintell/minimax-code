import { writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSshPerfSpan, sshPerfPathKey, recordSshPerf } from "./perf";
/**
 * Largest remote document staged for preview. Office documents well below this
 * still cost seconds on a bandwidth-capped SSH link, and anything larger is
 * better handled by downloading the file explicitly.
 */
const MAX_STAGED_PREVIEW_BYTES = 64 * 1024 * 1024;
/**
 * Materializes a remote SSH workspace file as a local file so the existing
 * document-preview pipeline can treat it as an ordinary local document.
 *
 * The preview pipeline is path-based end to end: workspace authority, the
 * source registry, the OOXML sanitizer, LibreOffice and QuickLook all need a
 * real local file. Staging is what lets every one of those stay unchanged,
 * rather than teaching each of them to speak SSH.
 *
 * Each staged copy lives in its own private directory so it can become the
 * preview workspace root without exposing any sibling file.
 */
export class SshRemotePreviewStaging {
    constructor(options) {
        this.options = options;
        this.staged = new Map();
        this.inFlight = new Map();
        this.bySender = new Map();
        this.disposed = false;
    }
    /**
     * Stage `filePath` from a remote workspace, reusing a previous copy when the
     * remote revision is unchanged. Returns `null` when the workspace is not a
     * known SSH project or the file could not be read.
     */
    async stage(input) {
        if (this.disposed || input.signal?.aborted)
            return null;
        const projectId = this.options.registry.projectIdForWorkspace(input.runtimeId, input.workspaceDir);
        if (!projectId)
            return null;
        if (!isSafeRelativePath(input.filePath))
            return null;
        const key = `${input.runtimeId}\u0000${input.workspaceDir}\u0000${input.filePath}`;
        let owner = this.bySender.get(input.senderId);
        if (!owner) {
            owner = new Set();
            this.bySender.set(input.senderId, owner);
        }
        const consumer = { senderId: input.senderId, owner, signal: input.signal };
        let attempt = this.inFlight.get(key);
        if (!attempt) {
            attempt = {
                controller: new AbortController(),
                consumers: new Set(),
                promise: Promise.resolve(null),
            };
            const current = attempt;
            // Register consumers before work starts, including synchronous failures.
            current.promise = Promise.resolve()
                .then(() => this.stageUncached(key, input, current))
                .catch((error) => {
                if (current.controller.signal.aborted)
                    return null;
                throw error;
            })
                .finally(() => {
                if (this.inFlight.get(key) === current)
                    this.inFlight.delete(key);
            });
            this.inFlight.set(key, current);
        }
        attempt.consumers.add(consumer);
        const onAbort = () => this.cancelUnownedAttempts();
        input.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const result = await attempt.promise;
            return this.isConsumerCurrent(consumer) ? result : null;
        }
        finally {
            attempt.consumers.delete(consumer);
            input.signal?.removeEventListener('abort', onAbort);
        }
    }
    async stageUncached(key, input, attempt) {
        const span = startSshPerfSpan('preview.stageRemoteSource', {
            lane: 'document-preview',
            target: sshPerfPathKey(`${input.workspaceDir}:${input.filePath}`),
        });
        if (!this.hasConsumers(attempt))
            return null;
        const read = await this.options.registry.readWorkspaceFileBytes(input.runtimeId, input.workspaceDir, input.filePath, {
            maxBytes: MAX_STAGED_PREVIEW_BYTES,
            signal: attempt.controller.signal,
        });
        if (!read || !this.hasConsumers(attempt)) {
            span.end({ outcome: 'error' });
            return null;
        }
        span.mark('downloaded');
        const existing = this.staged.get(key);
        if (existing && read.revision !== undefined && existing.revision === read.revision) {
            this.trackConsumers(attempt, existing);
            span.end({ outcome: 'cached', bytes: read.bytes.byteLength });
            return existing.source;
        }
        let dir;
        let published = false;
        try {
            if (!this.hasConsumers(attempt))
                return null;
            dir = await (this.options.createStagingDir ?? defaultStagingDir)();
            if (!this.hasConsumers(attempt))
                return null;
            const fileName = path.basename(input.filePath);
            const target = path.join(dir, fileName);
            // Owner-only: the staged copy is a verbatim reproduction of a private
            // remote document sitting in a world-readable temp root.
            await writeFile(target, read.bytes, { mode: 0o600 });
            if (!this.hasConsumers(attempt))
                return null;
            const source = { workspaceDir: dir, filePath: fileName };
            // Register ownership before publication; releaseSender must see a copy
            // even in the microtask between writing it and resolving the caller.
            const entry = { key, dir, source, revision: read.revision };
            this.trackConsumers(attempt, entry);
            this.staged.set(key, entry);
            published = true;
            // A path can have several live revisions. A newer download must not
            // remove a file still used by another preview, including in this window.
            if (existing && !this.isReferenced(existing))
                await this.discard(existing);
            span.end({ outcome: 'ok', bytes: read.bytes.byteLength });
            return source;
        }
        catch (error) {
            this.options.logger?.warn(`[SshPreviewStaging] failed to stage a remote document: ${String(error)}`);
            span.end({ outcome: 'error' });
            return null;
        }
        finally {
            if (dir && !published)
                await this.removeDirectory(dir);
        }
    }
    /** Revoke this renderer's pending work and copies without cancelling other consumers. */
    async releaseSender(senderId) {
        const entries = this.bySender.get(senderId);
        this.bySender.delete(senderId);
        this.cancelUnownedAttempts();
        if (!entries)
            return;
        for (const entry of entries) {
            if (this.isReferenced(entry))
                continue;
            await this.discard(entry);
        }
    }
    /** Stop admission immediately. Uncancellable I/O cleans its own late directory before returning. */
    async dispose() {
        this.disposed = true;
        const entries = new Set([
            ...this.staged.values(),
            ...[...this.bySender.values()].flatMap((owned) => [...owned]),
        ]);
        this.bySender.clear();
        this.cancelUnownedAttempts();
        for (const entry of entries)
            await this.discard(entry);
    }
    isConsumerCurrent(consumer) {
        return (!this.disposed &&
            !consumer.signal?.aborted &&
            this.bySender.get(consumer.senderId) === consumer.owner);
    }
    hasConsumers(attempt) {
        return (!attempt.controller.signal.aborted &&
            [...attempt.consumers].some((consumer) => this.isConsumerCurrent(consumer)));
    }
    trackConsumers(attempt, entry) {
        for (const consumer of attempt.consumers) {
            if (this.isConsumerCurrent(consumer))
                consumer.owner.add(entry);
        }
    }
    cancelUnownedAttempts() {
        for (const [key, attempt] of this.inFlight) {
            if (this.hasConsumers(attempt))
                continue;
            attempt.controller.abort();
            this.inFlight.delete(key);
        }
    }
    isReferenced(entry) {
        for (const entries of this.bySender.values()) {
            if (entries.has(entry))
                return true;
        }
        return false;
    }
    async discard(entry) {
        if (this.staged.get(entry.key) === entry)
            this.staged.delete(entry.key);
        await this.removeDirectory(entry.dir);
    }
    async removeDirectory(dir) {
        try {
            await rm(dir, { recursive: true, force: true });
        }
        catch (error) {
            recordSshPerf('preview.stageRemoteSource.cleanupFailed', {
                lane: 'document-preview',
                reason: String(error),
            });
        }
    }
}

function defaultStagingDir() {
    return mkdtemp(path.join(tmpdir(), 'mcode-ssh-preview-'));
}
/**
 * The staged copy becomes its own workspace root, so a traversal segment would
 * let a renderer name a file outside the remote workspace it opened.
 */
function isSafeRelativePath(value) {
    if (!value || value.length > 4096)
        return false;
    if (/[\u0000-\u001f\u007f]/u.test(value))
        return false;
    if (path.isAbsolute(value))
        return false;
    return !value.split(/[\\/]/u).some((segment) => segment === '..');
}
