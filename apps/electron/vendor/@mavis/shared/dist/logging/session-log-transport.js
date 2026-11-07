import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fdMatchesPath, OPEN_FILE_CHECK_INTERVAL_MS, writeFully } from './disk-transport.js';
/**
 * Per-Session log files. Each Session gets its own directory under the runtime
 * log directory, `sessions/<sessionId>/`, with one file per local day,
 * `runtime-MM-DD.log`, so the records of one Session can be read and uploaded
 * on their own. Records that belong to no Session stay in the hourly
 * `runtime-<YYYYMMDDHH>.log` files written by `./disk-transport.ts`.
 *
 * The limits match the hourly log: a day file that would grow past
 * `maxBytesPerFile` continues in `runtime-MM-DD.1.log`, `.2.log`, ..., and
 * while all Session files together exceed `maxTotalBytes` the oldest are
 * deleted.
 *
 * 和按小时的日志一样，每一行在 `write()` 返回前就写进了文件，进程随后崩溃也不丢。
 * 每个 Session 当天的文件写过之后一直开着，同时最多开 {@link MAX_OPEN_FILES} 个；开着的文件被删掉或换掉，
 * 距离上次核对超过 1 秒的那次写入会发现，重新建文件接着写。
 * 过期和超量清理在后台跑：先异步扫目录，再分批删，每删 {@link SWEEP_BATCH_SIZE} 个文件或目录让出一次事件循环，
 * 要删的多时也不会长时间挡住写入。超量时只留最新的文件和最近一次写入的文件，别的 Session 还开着的文件先关掉再删；
 * 扫描之后又写过的文件这一轮不删。
 */
export const SESSION_LOG_DIR = 'sessions';
const SESSION_ID_RE = /^(?:mvs|ses)_[A-Za-z0-9]{1,64}$/;
const SESSION_LOG_FILE_RE = /^runtime-(\d{2}-\d{2})(?:\.(\d+))?\.log$/;
const DEFAULT_MAX_BYTES_PER_FILE = 50 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 同时开着的 Session 文件上限，超出时关掉最久没写的那个，下次写到它时再打开。 */
const MAX_OPEN_FILES = 16;
/** 后台清理每删这么多个文件或目录，让出一次事件循环。 */
const SWEEP_BATCH_SIZE = 100;
export function isSessionLogFile(name) {
    return SESSION_LOG_FILE_RE.test(name);
}
/**
 * The Session a log record belongs to: its top-level `session_id` or
 * `sessionId`, when that is a real Session id. The id becomes a directory
 * name, so anything else is treated as no Session.
 */
export function readLogSessionId(fields) {
    const value = fields.session_id ?? fields.sessionId;
    return typeof value === 'string' && SESSION_ID_RE.test(value) ? value : undefined;
}
export function createSessionLogTransport(opts) {
    const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    const now = opts.now ?? Date.now;
    const onError = opts.onError ?? (() => { });
    const createdDirs = new Set();
    // 每个 Session 每天正在写的文件，键是 `<sessionId>/<MM-DD>`。按最近写入排序，最久没写的排在最前面。
    const openFiles = new Map();
    // 最近一次写入的文件。超量清理时它和最新的文件都不删。
    let lastWrittenPath;
    // Bytes of all Session files: counted by the last sweep, plus later writes.
    let totalBytes = 0;
    let sweptDay;
    let closed = false;
    let sweeping = null;
    let sweepAgain = false;
    const closeFd = (file) => {
        const fd = file.fd;
        if (fd === null)
            return;
        file.fd = null;
        try {
            fs.closeSync(fd);
        }
        catch (err) {
            onError(err);
        }
    };
    // 关掉并忘掉一个文件，下次写到这个 Session 这一天时重新找分片、重新打开。
    const forget = (key) => {
        const file = openFiles.get(key);
        if (!file)
            return;
        closeFd(file);
        openFiles.delete(key);
    };
    // 这个路径的文件还开着时，返回它在 openFiles 里的键。
    const openKeyOf = (filePath) => {
        for (const [key, file] of openFiles) {
            if (dayFilePath(file.sessionDir, file.day, file.part) === filePath)
                return key;
        }
        return undefined;
    };
    const hasOpenFileIn = (sessionDir) => {
        for (const file of openFiles.values()) {
            if (file.sessionDir === sessionDir)
                return true;
        }
        return false;
    };
    // 删掉过期文件，总量超限时再从最旧的删起，只留最新的文件和最近一次写入的文件，最后删掉删空的
    // Session 目录。要删的文件还开着就先关掉再删（Windows 上开着的文件删不干净），这个 Session 之后再写时
    // 重新找分片、重新打开。目录先在后台异步扫一遍，再分批删，每删 SWEEP_BATCH_SIZE 个文件或目录让出一次
    // 事件循环；两批之间可能有新的写入，所以每删一个都当场判断，不用扫描时的快照。
    const sweep = async () => {
        const scanned = await scanSessionLogFiles(opts.dir, onError);
        if (!scanned)
            return;
        const remaining = scanned.counts;
        let removals = 0;
        const yieldAfterBatch = async () => {
            removals += 1;
            if (removals % SWEEP_BATCH_SIZE === 0)
                await new Promise((resolve) => setImmediate(resolve));
        };
        const unlink = (file) => {
            if (file.path === lastWrittenPath)
                return false;
            let mtimeMs;
            try {
                mtimeMs = fs.statSync(file.path).mtimeMs;
            }
            catch (err) {
                if (err.code !== 'ENOENT')
                    return false;
                // 已经被别人删掉了，当作删过。
                remaining.set(file.dir, (remaining.get(file.dir) ?? 1) - 1);
                return true;
            }
            // 扫描之后又写过（修改时间变新了）：两批之间可能插进写入，它已经不是最旧的了，这一轮不删，
            // 否则刚写进去的行会跟着丢。
            if (mtimeMs > file.mtimeMs)
                return false;
            const key = openKeyOf(file.path);
            if (key !== undefined)
                forget(key);
            try {
                fs.unlinkSync(file.path);
                remaining.set(file.dir, (remaining.get(file.dir) ?? 1) - 1);
                return true;
            }
            catch (err) {
                onError(err);
                return false;
            }
        };
        const cutoff = now() - retentionMs;
        const expired = scanned.files.filter((file) => file.mtimeMs < cutoff);
        // Oldest first; parts written in the same millisecond keep their order.
        const files = scanned.files
            .filter((file) => file.mtimeMs >= cutoff)
            .sort((a, b) => a.mtimeMs - b.mtimeMs || a.part - b.part);
        // 删之前先按扫描结果算好总量，删的过程中插进来的写入会接着往上加。
        totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        for (const file of expired) {
            unlink(file);
            await yieldAfterBatch();
        }
        for (const file of files.slice(0, -1)) {
            if (totalBytes <= maxTotalBytes)
                break;
            if (unlink(file))
                totalBytes -= file.size;
            await yieldAfterBatch();
        }
        for (const [sessionDir, count] of remaining) {
            // 目录里还有开着的文件就不删；这一刻再查，扫描之后可能又写进来了。
            if (count > 0 || hasOpenFileIn(sessionDir))
                continue;
            try {
                fs.rmdirSync(sessionDir);
                createdDirs.delete(sessionDir);
            }
            catch (err) {
                // 扫描之后目录里又有了文件（比如别的进程写进来），或者目录已经没了，都不算错。
                const code = err.code;
                if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT')
                    onError(err);
            }
            await yieldAfterBatch();
        }
    };
    // 后台清理同一时间只跑一个；跑的过程中又有人要清理，跑完再来一遍。
    const scheduleSweep = () => {
        if (sweeping) {
            sweepAgain = true;
            return;
        }
        sweeping = (async () => {
            do {
                sweepAgain = false;
                try {
                    await sweep();
                }
                catch (err) {
                    onError(err);
                }
            } while (sweepAgain && !closed);
            sweeping = null;
        })();
    };
    const waitForSweeps = async () => {
        while (sweeping)
            await sweeping;
    };
    const append = (key, sessionId, day, text, at) => {
        let file = openFiles.get(key);
        if (file) {
            // 挪到最后，表示刚写过。
            openFiles.delete(key);
        }
        else {
            const sessionDir = path.join(opts.dir, sessionId);
            if (!createdDirs.has(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
                createdDirs.add(sessionDir);
            }
            const part = lastPart(sessionDir, day);
            const size = sizeOr0(dayFilePath(sessionDir, day, part));
            file = { sessionDir, day, part, size, fd: null, checkedAt: 0 };
        }
        openFiles.set(key, file);
        // Continue in the next part when this line would push the file past the
        // limit. A line larger than the limit still goes to one file.
        const buf = Buffer.from(text, 'utf8');
        while (file.size > 0 && file.size + buf.byteLength > maxBytesPerFile) {
            closeFd(file);
            file.part += 1;
            file.size = sizeOr0(dayFilePath(file.sessionDir, day, file.part));
        }
        const filePath = dayFilePath(file.sessionDir, day, file.part);
        // 距离上次核对超过 1 秒时，按路径核对开着的文件；被删掉或换掉了就关掉，下面重新打开（会新建文件）。
        if (file.fd !== null && at - file.checkedAt > OPEN_FILE_CHECK_INTERVAL_MS) {
            file.checkedAt = at;
            if (!fdMatchesPath(file.fd, filePath)) {
                closeFd(file);
                file.size = sizeOr0(filePath);
            }
        }
        if (file.fd === null) {
            file.fd = openForAppend(file.sessionDir, filePath);
            file.checkedAt = at;
        }
        writeFully(file.fd, buf);
        file.size += buf.byteLength;
        totalBytes += buf.byteLength;
        lastWrittenPath = filePath;
        // 开着的文件超过上限时，关掉最久没写的。
        for (const [openKey, openFile] of openFiles) {
            if (openFiles.size <= MAX_OPEN_FILES)
                break;
            closeFd(openFile);
            openFiles.delete(openKey);
        }
        if (totalBytes > maxTotalBytes)
            scheduleSweep();
    };
    return {
        write(sessionId, text) {
            if (closed || !SESSION_ID_RE.test(sessionId))
                return false;
            const at = now();
            const day = formatDayKey(at);
            // 每天第一次写入时，关掉前一天开着的文件，并在后台清理过期文件和空目录。
            if (day !== sweptDay) {
                sweptDay = day;
                for (const [key, file] of openFiles) {
                    if (file.day !== day)
                        forget(key);
                }
                scheduleSweep();
            }
            const key = `${sessionId}/${day}`;
            try {
                append(key, sessionId, day, text, at);
                return true;
            }
            catch (err) {
                forget(key);
                onError(err);
                return false;
            }
        },
        async flush() {
            await waitForSweeps();
        },
        async close() {
            closed = true;
            for (const key of [...openFiles.keys()])
                forget(key);
            await waitForSweeps();
        },
    };
}
function dayFilePath(sessionDir, day, part) {
    return path.join(sessionDir, part === 0 ? `runtime-${day}.log` : `runtime-${day}.${part}.log`);
}
/**
 * 异步扫一遍所有 Session 目录：列出里面的日志文件，并记下每个目录里一共有几个条目（不认识的文件也算，
 * 有它们的目录不会被当成空目录删掉）。读不了根目录时返回 null。
 */
async function scanSessionLogFiles(dir, onError) {
    let sessionIds;
    try {
        sessionIds = await fsp.readdir(dir);
    }
    catch {
        return null;
    }
    const files = [];
    const counts = new Map();
    for (const sessionId of sessionIds) {
        const sessionDir = path.join(dir, sessionId);
        let names;
        try {
            names = await fsp.readdir(sessionDir);
        }
        catch {
            continue;
        }
        counts.set(sessionDir, names.length);
        for (const name of names) {
            const match = SESSION_LOG_FILE_RE.exec(name);
            if (!match)
                continue;
            const filePath = path.join(sessionDir, name);
            try {
                const stat = await fsp.stat(filePath);
                files.push({
                    path: filePath,
                    dir: sessionDir,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs,
                    part: Number(match[2] ?? 0),
                });
            }
            catch (err) {
                onError(err);
            }
        }
    }
    return { files, counts };
}
/** 以追加方式打开文件。Session 目录在运行中被删掉时，重建一次再打开。 */
function openForAppend(sessionDir, filePath) {
    try {
        return fs.openSync(filePath, 'a');
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
        fs.mkdirSync(sessionDir, { recursive: true });
        return fs.openSync(filePath, 'a');
    }
}
/** The highest existing part of a Session's day file, so a restart keeps appending to it; 0 when there is none. */
function lastPart(sessionDir, day) {
    let names;
    try {
        names = fs.readdirSync(sessionDir);
    }
    catch {
        return 0;
    }
    let last = 0;
    for (const name of names) {
        const match = SESSION_LOG_FILE_RE.exec(name);
        if (match?.[1] === day)
            last = Math.max(last, Number(match[2] ?? 0));
    }
    return last;
}
function sizeOr0(filePath) {
    try {
        return fs.statSync(filePath).size;
    }
    catch {
        return 0;
    }
}
/** Local `MM-DD`, the same day format as the Electron log file names. */
function formatDayKey(epochMs) {
    const d = new Date(epochMs);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
//# sourceMappingURL=session-log-transport.js.map