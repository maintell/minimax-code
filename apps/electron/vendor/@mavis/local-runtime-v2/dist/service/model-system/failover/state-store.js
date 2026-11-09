import { settleInBackground } from '../../../infra/async/settle.js';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
/** The file is small (bounded sessions and marks); a larger one is not ours and is ignored. */
const MAX_FILE_BYTES = 1024 * 1024;
/** Changes within this window are written once. */
const FAILOVER_STORE_COALESCE_MS = 1_000;
/**
 * Failover state kept in the profile (`<profile>/model-access/failover-state.json`): session-id
 * hashes bound to provider keys and revoked sign-in marks (provider key + binding stamp). It never
 * holds a credential, payload or raw session id. Writes are atomic (temporary file, then rename)
 * and coalesced; a write lost to a crash only forgets the latest bindings. Several processes on
 * one profile overwrite each other's file (last writer wins), which only costs affinity.
 */
export class FailoverFileStateStore {
    file;
    coalesceMs;
    pending;
    timer;
    writing = Promise.resolve();
    constructor(file, coalesceMs = FAILOVER_STORE_COALESCE_MS) {
        this.file = file;
        this.coalesceMs = coalesceMs;
    }
    static forProfile(dataDir) {
        return new FailoverFileStateStore(path.join(dataDir, 'model-access', 'failover-state.json'));
    }
    load() {
        try {
            const text = readFileSync(this.file, 'utf8');
            if (text.length > MAX_FILE_BYTES)
                return undefined;
            const value = JSON.parse(text);
            if (!value || typeof value !== 'object' || value.version !== 1)
                return undefined;
            // Each entry is validated by the state as it is restored.
            return value;
        }
        catch {
            return undefined;
        }
    }
    save(state) {
        this.pending = state;
        if (this.timer)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            settleInBackground(this.flush());
        }, this.coalesceMs);
        this.timer.unref?.();
    }
    /** Writes what is pending now (tests, shutdown). */
    flush() {
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
        const state = this.pending;
        this.pending = undefined;
        if (!state)
            return this.writing;
        this.writing = this.writeAfter(this.writing, state);
        return this.writing;
    }
    /** Writes queue behind each other; a failed write is dropped (the next save retries). */
    async writeAfter(previous, state) {
        await previous;
        try {
            await this.write(state);
        }
        catch {
            /* Best effort: the in-memory state stays authoritative. */
        }
    }
    async write(state) {
        const temporary = `${this.file}.${randomUUID()}.pending`;
        try {
            await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
            await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
            await rename(temporary, this.file);
        }
        finally {
            await removeQuietly(temporary);
        }
    }
}
async function removeQuietly(file) {
    try {
        await unlink(file);
    }
    catch {
        /* Already renamed into place, or never written. */
    }
}
//# sourceMappingURL=state-store.js.map