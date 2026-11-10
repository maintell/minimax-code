import * as fs from "node:fs/promises";
import path from "node:path";
const DEFAULT_POLICY = { maxBytes: 10 * 1024 * 1024, backups: 4 };
const TRUNCATED_MARKER = Buffer.from(' [truncated]');
function isMissing(error) {
    return error?.code === 'ENOENT';
}
async function statRegular(file, rejectNonRegular = false) {
    try {
        const stat = await fs.lstat(file);
        if (stat.isFile())
            return stat;
        if (rejectNonRegular)
            throw new Error('bounded log storage: not a regular file');
        return undefined;
    }
    catch (error) {
        if (isMissing(error))
            return undefined;
        throw error;
    }
}
function clampIncoming(content, maxBytes) {
    if (content.length <= maxBytes)
        return content;
    const suffix = maxBytes > TRUNCATED_MARKER.length ? TRUNCATED_MARKER : Buffer.alloc(0);
    let end = maxBytes - suffix.length;
    while (end > 0 && (content[end] & 0xc0) === 0x80)
        end--;
    return Buffer.concat([content.subarray(0, end), suffix]);
}
/**
 * The caller serializes append and cleanup across all categories. Inventory
 * updates enforce the shared budget without scanning the directory per record.
 * External changes are picked up on rescan (or immediately for the active file).
 * Any I/O failure invalidates the inventory; never append after failed rotation.
 */
export function createBoundedLogStorage(options) {
    const maxDirectoryBytes = options.maxDirectoryBytes ?? 200 * 1024 * 1024;
    const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    const rescanIntervalMs = options.rescanIntervalMs ?? 60000;
    const now = options.now ?? (() => Date.now());
    const inventories = new Map();
    function inventory(logDir) {
        const existing = inventories.get(logDir);
        if (existing) {
            inventories.delete(logDir);
            inventories.set(logDir, existing);
            return existing;
        }
        if (inventories.size >= 4) {
            const oldest = inventories.keys().next().value;
            if (oldest !== undefined)
                inventories.delete(oldest);
        }
        const created = { entries: new Map(), totalBytes: 0, scannedAt: 0, valid: false };
        inventories.set(logDir, created);
        return created;
    }
    function setEntry(inv, name, entry) {
        inv.totalBytes -= inv.entries.get(name)?.size ?? 0;
        inv.entries.delete(name);
        if (entry) {
            inv.entries.set(name, entry);
            inv.totalBytes += entry.size;
        }
    }
    async function remove(logDir, inv, name) {
        // Re-check cached entries: cleanup must not delete a replacement symlink.
        if (await statRegular(path.join(logDir, name))) {
            try {
                await fs.unlink(path.join(logDir, name));
            }
            catch (error) {
                if (!isMissing(error))
                    throw error;
            }
        }
        setEntry(inv, name);
    }
    async function rescan(logDir, inv) {
        inv.valid = false;
        inv.entries.clear();
        inv.totalBytes = 0;
        for (const name of await fs.readdir(logDir)) {
            if (!options.isManagedFile(name))
                continue;
            const stat = await statRegular(path.join(logDir, name));
            if (stat)
                setEntry(inv, name, { size: stat.size, mtime: stat.mtimeMs });
        }
        const time = now();
        for (const [name, entry] of inv.entries) {
            if (time - entry.mtime > maxAgeMs)
                await remove(logDir, inv, name);
        }
        inv.scannedAt = time;
        inv.valid = true;
    }
    async function freeSpace(logDir, inv, incoming = 0) {
        // Avoid deleting any history when the new record alone cannot fit.
        if (incoming > maxDirectoryBytes)
            throw new Error('bounded log storage: directory budget exceeded');
        if (inv.totalBytes + incoming <= maxDirectoryBytes)
            return;
        const oldestFirst = [...inv.entries].sort((a, b) => a[1].mtime - b[1].mtime);
        for (const [name] of oldestFirst) {
            if (inv.totalBytes + incoming <= maxDirectoryBytes)
                break;
            await remove(logDir, inv, name);
        }
    }
    async function rotate(file, inv, policy) {
        const logDir = path.dirname(file);
        const name = path.basename(file);
        const backup = (index) => index === 0 ? name : name.replace(/\.log$/u, `.${index}.log`);
        // Validate every slot before mutating anything. An obstructed backup must
        // fail closed, not let the current file grow beyond its byte limit.
        for (let index = 0; index <= policy.backups; index++) {
            if (!options.isManagedFile(backup(index)))
                throw new Error('bounded log storage: backup is not managed');
            await statRegular(path.join(logDir, backup(index)), true);
        }
        if ((inv.entries.get(name)?.size ?? 0) > policy.maxBytes || policy.backups === 0) {
            // Do not migrate a legacy multi-GB current file into an oversized archive.
            await remove(logDir, inv, name);
            return;
        }
        await remove(logDir, inv, backup(policy.backups));
        for (let index = policy.backups - 1; index >= 0; index--) {
            const source = backup(index);
            const destination = backup(index + 1);
            const stat = await statRegular(path.join(logDir, source), true);
            if (!stat) {
                setEntry(inv, source);
                continue;
            }
            await fs.rename(path.join(logDir, source), path.join(logDir, destination));
            setEntry(inv, source);
            setEntry(inv, destination, { size: stat.size, mtime: stat.mtimeMs });
        }
    }
    return {
        async append(file, content, policy = DEFAULT_POLICY) {
            const logDir = path.dirname(file);
            const name = path.basename(file);
            const inv = inventory(logDir);
            try {
                if (!name.endsWith('.log') || !options.isManagedFile(name)) {
                    throw new Error('bounded log storage: target is not managed');
                }
                if (!Number.isSafeInteger(policy.maxBytes) ||
                    policy.maxBytes <= 0 ||
                    !Number.isSafeInteger(policy.backups) ||
                    policy.backups < 0) {
                    throw new Error('bounded log storage: invalid rotation policy');
                }
                const bytes = clampIncoming(content, policy.maxBytes);
                await fs.mkdir(logDir, { recursive: true });
                if (!inv.valid || now() - inv.scannedAt >= rescanIntervalMs)
                    await rescan(logDir, inv);
                // Reconcile the active file before enforcing budgets, not after append.
                const stat = await statRegular(file, true);
                setEntry(inv, name, stat ? { size: stat.size, mtime: stat.mtimeMs } : undefined);
                if (stat && stat.size + bytes.length > policy.maxBytes)
                    await rotate(file, inv, policy);
                await freeSpace(logDir, inv, bytes.length);
                await fs.appendFile(file, bytes, policy.mode === undefined ? undefined : { mode: policy.mode });
                const size = (inv.entries.get(name)?.size ?? 0) + bytes.length;
                setEntry(inv, name, { size, mtime: now() });
            }
            catch (error) {
                inv.valid = false;
                throw error;
            }
        },
        async cleanup(logDir) {
            const inv = inventory(logDir);
            try {
                await fs.mkdir(logDir, { recursive: true });
                await rescan(logDir, inv);
                await freeSpace(logDir, inv);
            }
            catch (error) {
                inv.valid = false;
                throw error;
            }
        },
    };
}
