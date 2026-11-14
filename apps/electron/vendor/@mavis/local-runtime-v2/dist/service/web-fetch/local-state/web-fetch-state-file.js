import fs from 'node:fs';
import { basename, dirname } from 'node:path';
import { replaceFileAtomically } from '../../../infra/file/jsonl.js';
import { logger } from '../../../infra/logging/logger.js';
const WARN_INTERVAL_MS = 10 * 60_000;
/**
 * Small JSON state files the web_fetch router keeps in the profile data dir.
 * Reads never throw: a missing or corrupt file is the same as no state.
 */
export function readWebFetchStateFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    catch {
        return undefined;
    }
}
/** Stored state is untrusted JSON; readers check its shape with this. */
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Persists one state file with at most one write in flight, followed by one
 * more if the state changed meanwhile. A failed write keeps the in-memory state,
 * never fails a web_fetch call, and leaves a rate-limited warning.
 */
export class CoalescedStateWriter {
    filePath;
    snapshot;
    now;
    writing;
    dirty = false;
    lastWarnedAtMs = Number.NEGATIVE_INFINITY;
    constructor(options) {
        this.filePath = options.filePath;
        this.snapshot = options.snapshot;
        this.now = options.now ?? Date.now;
    }
    markDirty() {
        this.dirty = true;
        this.writing ??= this.writeLoop();
    }
    /** Resolves once every change marked so far has been written or given up on. */
    async flush() {
        // A change marked as a write loop ends starts another loop; wait for that too.
        while (this.writing)
            await this.writing;
    }
    async writeLoop() {
        // Yield first so the finally below runs after markDirty has stored this
        // promise. A synchronous exit (no data dir yet) would otherwise leave a
        // settled promise stored, and no later change would ever be written.
        await Promise.resolve();
        const filePath = this.filePath();
        try {
            while (this.dirty && filePath) {
                this.dirty = false;
                await this.write(filePath);
            }
        }
        finally {
            this.writing = undefined;
        }
    }
    async write(filePath) {
        try {
            await fs.promises.mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
            await replaceFileAtomically(filePath, JSON.stringify(this.snapshot()));
        }
        catch (error) {
            this.warn(filePath, error);
        }
    }
    warn(filePath, error) {
        const nowMs = this.now();
        if (nowMs - this.lastWarnedAtMs < WARN_INTERVAL_MS)
            return;
        this.lastWarnedAtMs = nowMs;
        const code = error?.code;
        logger.warn({ file: basename(filePath), error_code: typeof code === 'string' ? code : 'unknown' }, 'web_fetch state file write failed');
    }
}
//# sourceMappingURL=web-fetch-state-file.js.map