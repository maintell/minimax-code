import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
const DEFAULT_MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 开着的日志文件距离上次核对超过这么久（毫秒），下一次写之前按路径再核对一次。按会话的日志文件也用它。 */
export const OPEN_FILE_CHECK_INTERVAL_MS = 1000;
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
        fd: null,
        checkedAt: 0,
    };
    let dirEnsured = false;
    let closed = false;
    let sweepInFlight = false;
    let sweepQueued = false;
    const filenameFor = (hourKey, part) => part === 0 ? `${prefix}-${hourKey}.log` : `${prefix}-${hourKey}.${part}.log`;
    const ensureDir = () => {
        if (dirEnsured)
            return;
        fs.mkdirSync(dir, { recursive: true });
        dirEnsured = true;
    };
    // 关掉当前文件：换小时、写满换下一个分片、写失败和 close() 时调用。
    const closeFile = () => {
        const fd = state.fd;
        if (fd === null)
            return;
        state.fd = null;
        try {
            fs.closeSync(fd);
        }
        catch (err) {
            onError(err);
        }
    };
    // 以追加方式打开文件。日志目录在运行中被删掉时，重建一次再打开。
    const openFile = (filePath) => {
        try {
            return fs.openSync(filePath, 'a');
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
            fs.mkdirSync(dir, { recursive: true });
            return fs.openSync(filePath, 'a');
        }
    };
    const rotateFor = (byteLen, at) => {
        const hourKey = formatHourKey(at);
        if (hourKey !== state.hourKey) {
            closeFile();
            state.hourKey = hourKey;
            state.partIndex = 0;
            state.currentPath = path.join(dir, filenameFor(hourKey, 0));
            state.currentSize = fileSizeOr0(state.currentPath);
            scheduleSweep();
        }
        // Roll to `.N.log` inside the same hour bucket if the write would push
        // us past maxBytesPerFile. Skip when `currentSize === 0` so a single
        // oversized log line still lands somewhere instead of triggering an
        // infinite roll loop.
        let rolledIntraHour = false;
        while (state.currentSize > 0 && state.currentSize + byteLen > maxBytesPerFile) {
            closeFile();
            state.partIndex += 1;
            state.currentPath = path.join(dir, filenameFor(state.hourKey, state.partIndex));
            state.currentSize = fileSizeOr0(state.currentPath);
            rolledIntraHour = true;
        }
        return rolledIntraHour;
    };
    const scheduleSweep = () => {
        if (sweepInFlight) {
            sweepQueued = true;
            return;
        }
        sweepInFlight = true;
        // 清理放到后台跑，慢的清理不会拖住任何一行日志。它从不删最新的文件，也就不会删到正在写的文件。
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
            return false;
        const buf = Buffer.from(text, 'utf8');
        const at = now();
        try {
            ensureDir();
            const rolledIntraHour = rotateFor(buf.byteLength, at);
            if (!state.currentPath)
                return false;
            // 距离上次核对超过 1 秒时，按路径核对开着的文件；被删掉或换掉了就关掉，下面重新打开（会新建文件）。
            if (state.fd !== null && at - state.checkedAt > OPEN_FILE_CHECK_INTERVAL_MS) {
                state.checkedAt = at;
                if (!fdMatchesPath(state.fd, state.currentPath)) {
                    closeFile();
                    state.currentSize = fileSizeOr0(state.currentPath);
                }
            }
            if (state.fd === null) {
                state.fd = openFile(state.currentPath);
                state.checkedAt = at;
            }
            writeFully(state.fd, buf);
            state.currentSize += buf.byteLength;
            // Intra-hour rollover is exactly the case where a single hour is on
            // track to blow past `maxTotalBytes` — a busy hour can produce many
            // `.N.log` shards before the natural hour-boundary sweep. Kick the
            // sweep after the new shard is written so the total-bytes cap sees the
            // shard that caused the rollover. (Codex Review P2 on MR !3981.)
            if (rolledIntraHour) {
                scheduleSweep();
            }
            return true;
        }
        catch (err) {
            // 写失败时关掉文件，下一次写入重新打开：打不开的原因（比如文件位置被目录占着）消失后就能接着写。
            // 文件开着时被删掉或换掉不会让写入失败，靠上面写之前的核对发现。
            closeFile();
            onError(err);
            return false;
        }
    };
    const flush = async () => { };
    const close = async () => {
        if (closed)
            return;
        closed = true;
        closeFile();
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
function fileSizeOr0(p) {
    try {
        const stat = fs.statSync(p);
        return stat.isFile() ? stat.size : 0;
    }
    catch {
        return 0;
    }
}
/**
 * `fd` 是不是还是 `filePath` 上的那个文件。文件开着时被删掉或换掉（用户手动删日志、共用数据目录的另一个
 * 进程清理），往旧的 fd 写不会出错，行会写进已经删掉的文件，所以写之前隔一阵按路径核对一次。按路径查不到
 * （ENOENT，或者 Windows 上删除还没完成时的 EPERM 等）也算不是。按会话的日志文件也用它，不在包外导出。
 */
export function fdMatchesPath(fd, filePath) {
    try {
        const onDisk = fs.statSync(filePath);
        const open = fs.fstatSync(fd);
        return onDisk.ino === open.ino && onDisk.dev === open.dev;
    }
    catch {
        return false;
    }
}
/** 把整段内容写进文件；一次没写完就接着写剩下的。按会话的日志文件也用它，不在包外导出。 */
export function writeFully(fd, buf) {
    let offset = 0;
    while (offset < buf.byteLength) {
        const written = fs.writeSync(fd, buf, offset, buf.byteLength - offset);
        if (written <= 0)
            throw new Error('disk log write made no progress');
        offset += written;
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