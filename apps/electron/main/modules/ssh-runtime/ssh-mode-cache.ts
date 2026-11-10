import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import electronStore from "electron-store";
import { buildSshExecArgs } from "./ssh-command.js";
import { spawnOwnedSsh, stopOwnedSsh } from "./ssh-process.js";
/** Profile-owned launch capabilities, never authentication or live channels. */
export class SshModeCache {
    constructor(fingerprint = readSshConfigurationFingerprint, createStore) {
        this.fingerprint = fingerprint;
        this.createStore = createStore;
        this.generation = 0;
        this.loaded = false;
        this.epochs = new Map();
        this.entries = new Map();
    }
    async inspect(endpoint, signal, timeoutMs = 3000) {
        signal?.throwIfAborted();
        this.load();
        const generation = this.generation;
        const key = endpointKey(endpoint);
        const epoch = this.epochs.get(key) ?? {};
        this.epochs.set(key, epoch);
        let fingerprint;
        try {
            fingerprint = await this.fingerprint(endpoint, signal, Math.min(3000, timeoutMs));
        }
        catch {
            // A cache inspection failure must fall back to a fresh, bounded probe.
        }
        signal?.throwIfAborted();
        if (!fingerprint) {
            if (this.epochs.get(key) === epoch) {
                if (this.entries.delete(key))
                    this.persist();
                this.epochs.delete(key);
            }
            return undefined;
        }
        if (generation !== this.generation || this.epochs.get(key) !== epoch)
            return undefined;
        const cached = this.entries.get(key);
        this.entries.delete(key);
        const valid = cached?.fingerprint === fingerprint;
        if (valid)
            this.entries.set(key, cached);
        else if (cached)
            this.persist();
        return { key, fingerprint, generation, epoch, ...(valid ? { mode: cached.mode } : {}) };
    }
    remember(ticket, mode) {
        if (!ticket ||
            ticket.generation !== this.generation ||
            this.epochs.get(ticket.key) !== ticket.epoch)
            return;
        this.entries.delete(ticket.key);
        this.entries.set(ticket.key, {
            fingerprint: ticket.fingerprint,
            mode,
        });
        while (this.entries.size > 128) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.entries.delete(oldest);
            this.epochs.delete(oldest);
        }
        this.persist();
    }
    invalidate(endpoint) {
        this.load();
        const key = endpointKey(endpoint);
        if (this.entries.delete(key))
            this.persist();
        this.epochs.delete(key);
    }
    /** Also invalidates probes started before a configuration/lifecycle change. */
    clear() {
        this.load();
        this.generation += 1;
        this.entries.clear();
        this.epochs.clear();
        this.persist();
    }
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            this.store = this.createStore?.();
            const snapshot = this.store?.get('snapshot');
            if (!isRecord(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.entries))
                return;
            for (const entry of snapshot.entries.slice(-128)) {
                if (isRecord(entry) &&
                    typeof entry.key === 'string' &&
                    /^[a-f0-9]{64}$/u.test(entry.key) &&
                    typeof entry.fingerprint === 'string' &&
                    /^[a-f0-9]{64}$/u.test(entry.fingerprint) &&
                    (entry.mode === 'exec' || entry.mode === 'shell-stdin')) {
                    this.entries.set(entry.key, { fingerprint: entry.fingerprint, mode: entry.mode });
                }
            }
        }
        catch {
            // An unavailable preference store must not prevent a fresh SSH probe.
        }
    }
    persist() {
        try {
            this.store?.set('snapshot', {
                version: 1,
                entries: [...this.entries].map(([key, value]) => ({ key, ...value })),
            });
        }
        catch {
            // Continue using the verified in-memory mode if local storage is unavailable.
        }
    }
}

export function createPersistentSshModeCache() {
    return new SshModeCache(readSshConfigurationFingerprint,
    // Resolve userData only on first use, after Desktop selects its profile.
    () => new electronStore({ name: 'ssh-launch-modes' }));
}
function endpointKey(endpoint) {
    return createHash('sha256').update(JSON.stringify(endpoint)).digest('hex');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** ssh -G expands Include/Match/route settings locally; no connection or key contents are retained. */
export async function readSshConfigurationFingerprint(endpoint, signal, timeoutMs, spawnProcess = spawnOwnedSsh) {
    if (timeoutMs <= 0)
        return undefined;
    const deadline = Date.now() + timeoutMs;
    const child = spawnProcess(['-v', '-G', ...buildSshExecArgs(endpoint, '-T', ':').slice(0, -1)]);
    let diagnostics = '';
    try {
        const config = await new Promise((resolve) => {
            let output = '';
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                resolve(value);
            };
            const cancel = () => finish();
            const timer = setTimeout(cancel, timeoutMs);
            child.stdout.on('data', (chunk) => {
                if (settled)
                    return;
                if (Buffer.byteLength(output) + chunk.length > 1024 * 1024)
                    finish();
                else
                    output += chunk.toString('utf8');
            });
            child.stderr.on('data', (chunk) => {
                if (settled)
                    return;
                if (Buffer.byteLength(diagnostics) + chunk.length > 256 * 1024)
                    finish();
                else
                    diagnostics += chunk.toString('utf8');
            });
            child.on('error', () => finish());
            child.stdin.on('error', () => finish());
            child.once('close', (code) => finish(code === 0 ? output : undefined));
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted)
                cancel();
            else
                child.stdin.end();
        });
        if (!config || signal?.aborted)
            return undefined;
        const paths = config.split(/\r?\n/u).flatMap((line) => {
            const match = /^(?:identityfile|certificatefile|identityagent|userknownhostsfile|globalknownhostsfile) (.+)$/u.exec(line);
            return match ? match[1].split(/\s+/u) : [];
        });
        if (process.env.SSH_AUTH_SOCK)
            paths.push(process.env.SSH_AUTH_SOCK);
        // A changed jump-host stanza may leave the flattened `proxyjump <alias>`
        // value unchanged. Include metadata for every configuration file SSH read.
        for (const match of diagnostics.matchAll(/^debug1: Reading configuration data (.+)$/gmu)) {
            paths.push(match[1].trim());
        }
        if (paths.length > 256)
            return undefined;
        if (signal?.aborted || Date.now() >= deadline)
            return undefined;
        const metadataWork = Promise.all(paths.map(async (path) => {
            const expanded = path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path;
            try {
                const file = await stat(expanded);
                return [expanded, file.dev, file.ino, file.size, file.mtimeMs, file.ctimeMs];
            }
            catch {
                return [expanded, 'unavailable'];
            }
        }));
        // A key/agent path may live on an unavailable mounted filesystem. Such a
        // stat must not hold the request open after the cache-inspection deadline.
        const metadata = await new Promise((resolve) => {
            const cancel = () => finish();
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                resolve(value);
            };
            const timer = setTimeout(cancel, Math.max(0, deadline - Date.now()));
            signal?.addEventListener('abort', cancel, { once: true });
            if (signal?.aborted)
                cancel();
            else
                void metadataWork.then(finish, cancel);
        });
        if (!metadata)
            return undefined;
        return createHash('sha256')
            .update(JSON.stringify(['ssh-mode-v1', config, metadata]))
            .digest('hex');
    }
    finally {
        await stopOwnedSsh(child);
    }
}
