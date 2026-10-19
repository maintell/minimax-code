import fsp from 'node:fs/promises';
import path from 'node:path';
const DEFAULT_MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Build an hourly-rotating file transport with retention + total-bytes cap.
 *
 * Ownership contract: the caller (typically a runtime host wiring block)
 * owns the returned handle and must call {@link DiskLogTransport.close} on
 * shutdown. The transport does NOT install any process-level exit hooks —
 * that is a host concern.
 */
export function createDiskLogTransport(opts) {
    const dir = opts.dir;
    const prefix = opts.prefix ?? 'runtime';
    const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    const now = opts.now ?? Date.now;
    const onError = opts.onError ?? (() => { });
    if (prefix.length === 0 || /[/\\]/.test(prefix)) {
        throw new Error(`createDiskLogTransport: invalid prefix ${JSON.stringify(prefix)}`);
    }
    if (maxBytesPerFile <= 0 || maxTotalBytes <= 0 || retentionMs <= 0) {
        throw new Error('createDiskLogTransport: maxBytesPerFile, maxTotalBytes, retentionMs must be > 0');
    }
    const state = {
        hourKey: null,
        partIndex: 0,
        currentPath: null,
        currentSize: 0,
    };
    let writeChain = Promise.resolve();
    let dirEnsured = false;
    let closed = false;
    let sweepInFlight = false;
    let sweepQueued = false;
    const filenameFor = (hourKey, part) => part === 0 ? `${prefix}-${hourKey}.log` : `${prefix}-${hourKey}.${part}.log`;
    const ensureDir = async () => {
        if (dirEnsured)
            return;
        await fsp.mkdir(dir, { recursive: true });
        dirEnsured = true;
    };
    const rotateFor = async (byteLen) => {
        const hourKey = formatHourKey(now());
        if (hourKey !== state.hourKey) {
            state.hourKey = hourKey;
            state.partIndex = 0;
            state.currentPath = path.join(dir, filenameFor(hourKey, 0));
            state.currentSize = await statSizeOr0(state.currentPath);
            scheduleSweep();
        }
        // Roll to `.N.log` inside the same hour bucket if the write would push
        // us past maxBytesPerFile. Skip when `currentSize === 0` so a single
        // oversized log line still lands somewhere instead of triggering an
        // infinite roll loop.
        let rolledIntraHour = false;
        while (state.currentSize > 0 && state.currentSize + byteLen > maxBytesPerFile) {
            state.partIndex += 1;
            state.currentPath = path.join(dir, filenameFor(state.hourKey, state.partIndex));
            state.currentSize = await statSizeOr0(state.currentPath);
            rolledIntraHour = true;
        }
        return rolledIntraHour;
    };
    const doWrite = async (text) => {
        // Do NOT short-circuit on `closed` here — writes that were enqueued
        // before `close()` swapped the flag must still land, otherwise the
        // close+await pattern would silently drop the last few lines.
        const buf = Buffer.from(text, 'utf8');
        try {
            await ensureDir();
        }
        catch (err) {
            onError(err);
            return;
        }
        let rolledIntraHour = false;
        try {
            rolledIntraHour = await rotateFor(buf.byteLength);
        }
        catch (err) {
            onError(err);
            return;
        }
        if (!state.currentPath)
            return;
        try {
            await fsp.appendFile(state.currentPath, buf);
            state.currentSize += buf.byteLength;
            // Intra-hour rollover is exactly the case where a single hour is on
            // track to blow past `maxTotalBytes` — a busy hour can produce many
            // `.N.log` shards before the natural hour-boundary sweep. Kick the
            // sweep after the new shard is written so the total-bytes cap sees the
            // shard that caused the rollover. (Codex Review P2 on MR !3981.)
            if (rolledIntraHour) {
                scheduleSweep();
            }
        }
        catch (err) {
            onError(err);
        }
    };
    const scheduleSweep = () => {
        if (sweepInFlight) {
            sweepQueued = true;
            return;
        }
        sweepInFlight = true;
        // Detach from the write chain so a slow sweep never delays a log line.
        // Uses queueMicrotask so tests that await flush() also see the sweep
        // complete synchronously via close()'s runFinalSweep step.
        void Promise.resolve()
            .then(() => runRetentionSweep({ dir, prefix, maxTotalBytes, retentionMs, now, onError }))
            .catch((err) => onError(err))
            .finally(() => {
            sweepInFlight = false;
            if (sweepQueued) {
                sweepQueued = false;
                scheduleSweep();
            }
        });
    };
    const write = (text) => {
        if (closed)
            return;
        writeChain = writeChain
            .then(() => doWrite(text))
            .catch((err) => {
            onError(err);
        });
    };
    const flush = async () => {
        // Snapshot the chain locally so writes issued during the await don't
        // extend the flush indefinitely.
        const pending = writeChain;
        await pending;
    };
    const close = async () => {
        if (closed)
            return;
        closed = true;
        try {
            await writeChain;
        }
        catch {
            // errors already routed via onError inside the chain
        }
        // Wait for any in-flight background sweep before running the final one,
        // so the final result is deterministic for tests.
        await waitFor(() => !sweepInFlight);
        try {
            await runRetentionSweep({ dir, prefix, maxTotalBytes, retentionMs, now, onError });
        }
        catch (err) {
            onError(err);
        }
    };
    return {
        write,
        flush,
        close,
        getCurrentFilePath: () => state.currentPath,
    };
}
/**
 * Format an epoch-ms timestamp as `YYYYMMDDHH` in the local timezone. Local
 * TZ matches the Electron main-process file logger (`getDateString()`),
 * which uses the user's wall-clock time so the filename lines up with what
 * they see in the UI when they trigger a feedback upload.
 */
export function formatHourKey(epochMs) {
    const d = new Date(epochMs);
    const y = d.getFullYear().toString().padStart(4, '0');
    const m = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    return `${y}${m}${day}${hh}`;
}
async function statSizeOr0(p) {
    try {
        const stat = await fsp.stat(p);
        return stat.isFile() ? stat.size : 0;
    }
    catch {
        return 0;
    }
}
async function waitFor(pred, tries = 50, delayMs = 5) {
    for (let i = 0; i < tries; i += 1) {
        if (pred())
            return;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
}
/**
 * Enforce retention (mtime cutoff) and total-bytes cap on the log directory.
 *
 * Sweep is best-effort: individual unlink errors are surfaced via `onError`
 * and skipped; a `readdir` failure is treated as "directory does not exist
 * yet" (typical before the very first write) and returns silently.
 */
async function runRetentionSweep(opts) {
    const { dir, prefix, maxTotalBytes, retentionMs, now, onError } = opts;
    let entries;
    try {
        entries = await fsp.readdir(dir);
    }
    catch {
        return;
    }
    const pattern = new RegExp(`^${escapeRegex(prefix)}-\\d{10}(?:\\.\\d+)?\\.log$`);
    const cutoff = now() - retentionMs;
    const stats = [];
    for (const name of entries) {
        if (!pattern.test(name))
            continue;
        const filePath = path.join(dir, name);
        try {
            const stat = await fsp.stat(filePath);
            if (!stat.isFile())
                continue;
            stats.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs, live: true });
        }
        catch {
            // Skip individual failures
        }
    }
    // 1) mtime retention
    for (const e of stats) {
        if (e.mtimeMs < cutoff) {
            try {
                await fsp.unlink(e.path);
                e.live = false;
            }
            catch (err) {
                onError(err);
            }
        }
    }
    // 2) total-bytes cap — evict oldest until under budget. Keep at least the
    //    newest file even if it alone exceeds the cap, so the transport can
    //    still land the current hour's writes.
    const remaining = stats
        .filter((e) => e.live)
        .sort((a, b) => a.mtimeMs - b.mtimeMs || compareLogPaths(a.path, b.path));
    let total = remaining.reduce((sum, e) => sum + e.size, 0);
    for (let i = 0; i < remaining.length - 1 && total > maxTotalBytes; i += 1) {
        const e = remaining[i];
        if (!e)
            continue;
        try {
            await fsp.unlink(e.path);
            total -= e.size;
        }
        catch (err) {
            onError(err);
        }
    }
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function compareLogPaths(a, b) {
    const ap = parseLogPath(path.basename(a));
    const bp = parseLogPath(path.basename(b));
    if (!ap || !bp)
        return path.basename(a).localeCompare(path.basename(b));
    return ap.hourKey.localeCompare(bp.hourKey) || ap.partIndex - bp.partIndex;
}
function parseLogPath(name) {
    const match = /-(\d{10})(?:\.(\d+))?\.log$/.exec(name);
    if (!match)
        return null;
    const hourKey = match[1];
    if (!hourKey)
        return null;
    return { hourKey, partIndex: match[2] ? Number(match[2]) : 0 };
}
//# sourceMappingURL=disk-transport.js.map