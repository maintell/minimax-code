import fs from "fs";
import path from "path";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { resolveLocalRuntimeV2DirectoryContract } from "../modules/local-runtime/v2-paths";
/**
 * Per-file tail cap for external log files when running in plain-tail mode:
 * 20MB (files larger than this are truncated to the trailing 20MB).
 *
 * Rationale: on a typical dev machine the rolling 2-day window peaks around
 * 669MB with single files up to 401MB; capping per-file at 20MB brings the
 * total to ~169MB (~21MB after zip), which is the best balance between
 * covering recent activity for triage and keeping upload cost reasonable.
 */
export let RUNTIME_LOG_TAIL_BYTES = 20 * 1024 * 1024;
/** Lines of surrounding context kept on each side of every ERROR/WARN/FATAL hit. */
export let RUNTIME_ERROR_CONTEXT_LINES = 50;
/** Hard cap on the filtered output buffer per file (5MB ≈ 25k lines). */
export let RUNTIME_ERROR_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
/** Files modified within the last hour keep a tail even if they have 0 errors. */
export let RUNTIME_FALLBACK_RECENT_MS = 60 * 60 * 1000;
/** Tail size used for the recent-but-clean fallback. */
export let RUNTIME_FALLBACK_TAIL_BYTES = 1 * 1024 * 1024;
/**
 * Default error-level detector: matches lines whose very first token is
 * `ERROR` / `WARN` / `FATAL` followed by whitespace or end-of-line. Sources
 * whose log format places the level token elsewhere must supply
 * `ErrorContextConfig.errorRegex` instead.
 */
const DEFAULT_ERROR_LEVEL_REGEX = /^(?:ERROR|WARN|FATAL)(?:\s|$)/;
/**
 * Error-level detector for local runtime logs. These logs use pino-pretty or
 * a compatible formatter, so each line begins with a bracketed timestamp
 * followed by the level token, e.g.
 * `[21:13:09.907] ERROR: [local-runtime] ...`.
 */
const LOCAL_RUNTIME_ERROR_LEVEL_REGEX = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+(?:ERROR|WARN|FATAL)[\s:]/;
/**
 * Resolve the local runtime logs directory, so that an electron instance launched with
 * `MAVIS_DEV_USE_GIT_PROFILE=1` uploads logs from its own per-worktree
 * dataDir (`~/.minimax-<branch>/logs`) instead of the installed `.app`'s
 * (`~/.minimax/logs`).
 */
export function resolveRuntimeLogsDir() {
    return resolveLocalRuntimeV2DirectoryContract(resolveLocalRuntimeDataDir()).logs;
}
/**
 * File-name patterns produced by the local runtime and its sub-processes.
 *
 * The `(?:\.\d+)?` optional part after the hour bucket matches the
 * intra-hour rollover files (`runtime-YYYYMMDDHH.1.log`, `.2.log`, ...)
 * emitted by `@mavis/shared/logging`'s disk transport when a single hour
 * exceeds its `maxBytesPerFile` cap. Older sinks that never rolled the file
 * still match because the `?` makes the part suffix optional.
 * When a file gains a new log family, add the matching pattern here so the
 * new files end up in upload-log bundles too.
 */
const RUNTIME_LOG_PATTERNS = [
    /^local-runtime-\d{10}(?:\.\d+)?\.log$/,
    /^runtime-\d{10}(?:\.\d+)?\.log$/,
    /^im-runtime-\d{10}(?:\.\d+)?\.log$/,
    /^local-proxy-\d{10}(?:\.\d+)?\.jsonl$/,
];
function isRuntimeLogFile(name) {
    for (const p of RUNTIME_LOG_PATTERNS) {
        if (p.test(name))
            return true;
    }
    return false;
}
function isRuntimeEventFile(name) {
    return /^runtime-events-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name);
}
function isSessionArtifactFile(name, relativeName) {
    const isCanonicalArtifact = name === 'manifest.json' ||
        name === 'display.jsonl' ||
        name === 'ledger.jsonl' ||
        name === 'snapshot.json';
    if (!isCanonicalArtifact || !relativeName)
        return false;
    const parts = relativeName.split('/').filter(Boolean);
    if (parts.length !== 5)
        return false;
    const [year, month, day, sessionDir, fileName] = parts;
    return (fileName === name &&
        /^\d{4}$/.test(year ?? '') &&
        /^(?:0[1-9]|1[0-2])$/.test(month ?? '') &&
        /^(?:0[1-9]|[12]\d|3[01])$/.test(day ?? '') &&
        /^\d{2}-\d{2}-\d{2}-\d{3}-session_[A-Za-z0-9_-]+$/.test(sessionDir ?? ''));
}
/**
 * Return all external log sources to bundle alongside the main log files.
 *
 * Currently includes:
 * - Local runtime logs under the active runtime data directory
 *   (`~/.minimax/logs`, `~/.minimax-<branch>/logs`, or `MAVIS_DATA_DIR/logs`).
 * - Structured runtime events under `v2/observability/events`, preserving
 *   turn lifecycle telemetry that may never become ERROR/WARN log lines.
 * - Session diagnostics under `v2/sessions`, also available to ordinary log
 *   uploads without the feedback-only selected Session report.
 * - CLI incident reports under `v2/observability/cli/incidents`.
 *
 * 当前 v2 目录下的 runtime 日志整份带：打包版里 runtime 的日志只写在这些文件里，main 日志不再抄一份，
 * 只截报错附近的行会丢掉排查要用的普通日志。迁移期旧目录 `logs/` 下的 runtime 日志仍只带报错前后的行。
 *
 * Uploads are user-triggered from the desktop sidebar, Settings -> About, or
 * the app menu. The canonical `messages.jsonl` conversation/tool-call file is
 * deliberately excluded even with that explicit action; remaining diagnostic
 * artifacts must still be treated as potentially sensitive.
 */
export function getExtraLogSources() {
    const dataDir = resolveLocalRuntimeDataDir();
    const contract = resolveLocalRuntimeV2DirectoryContract(dataDir);
    const legacyLogsDir = path.join(dataDir, 'logs');
    return [
        {
            dir: resolveRuntimeLogsDir(),
            match: isRuntimeLogFile,
            prefix: 'mavis-runtime/',
            recursive: true,
        },
        {
            dir: legacyLogsDir,
            match: isRuntimeLogFile,
            prefix: 'legacy/mavis-runtime/',
            errorContext: {
                contextLines: RUNTIME_ERROR_CONTEXT_LINES,
                maxOutputBytes: RUNTIME_ERROR_MAX_OUTPUT_BYTES,
                fallbackRecentMs: RUNTIME_FALLBACK_RECENT_MS,
                fallbackTailBytes: RUNTIME_FALLBACK_TAIL_BYTES,
                errorRegex: LOCAL_RUNTIME_ERROR_LEVEL_REGEX,
            },
        },
        {
            dir: contract.events,
            match: isRuntimeEventFile,
            prefix: 'mavis-runtime-events/',
            recursive: true,
            maxBytesPerFile: RUNTIME_LOG_TAIL_BYTES,
        },
        {
            dir: contract.sessions,
            match: isSessionArtifactFile,
            prefix: 'mavis-sessions/',
            recursive: true,
        },
        {
            dir: path.join(contract.observability, 'cli', 'incidents'),
            match: (name) => name.endsWith('.json'),
            prefix: 'mavis-cli-incidents/',
        },
        ...(process.platform === 'win32' && process.env.LOCALAPPDATA
            ? [
                {
                    dir: path.join(process.env.LOCALAPPDATA, 'MiniMax', 'installer-logs'),
                    match: (name) => /^nsis-[A-Za-z0-9.+_-]+-\d+\.log$/.test(name),
                    prefix: 'windows-installer/',
                    maxBytesPerFile: 1024 * 1024,
                },
            ]
            : []),
    ];
}
/**
 * Read the trailing `maxBytes` bytes of a file, aligned to the start of the
 * next newline so the result begins on a complete line. This avoids a
 * truncated leading line that would confuse downstream log parsers.
 *
 * If the file is no larger than `maxBytes`, or no newline is found in the
 * tail window, the raw tail bytes are returned as-is.
 */
export function readTailWithLineAlign(filePath, fileSize, maxBytes) {
    const startOffset = Math.max(0, fileSize - maxBytes);
    const length = fileSize - startOffset;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, startOffset);
        if (startOffset === 0) {
            return buf;
        }
        const nl = buf.indexOf(0x0a); // '\n'
        if (nl === -1 || nl === buf.length - 1) {
            return buf;
        }
        return buf.subarray(nl + 1);
    }
    finally {
        fs.closeSync(fd);
    }
}
/**
 * Stream the file line by line and emit only ERROR/WARN/FATAL lines plus
 * `contextLines` of surrounding context on each side. When two error hits are
 * close enough that their context windows overlap the output is contiguous;
 * when they are far apart a `... [N lines skipped] ...` separator is inserted
 * so the reader can tell.
 *
 * Implementation notes:
 * - Reads in 64KB chunks (sync) to keep memory bounded for multi-hundred-MB
 *   files; line splitting carries an incomplete-line buffer across chunks.
 * - When the cumulative output reaches `maxOutputBytes`, scanning stops and a
 *   final `... [truncated] ...` marker is appended.
 * - Returns an empty Buffer when the file contains zero ERROR/WARN/FATAL
 *   lines, signalling to the caller that fallback logic should run.
 */
export function extractErrorContext(filePath, contextLines, maxOutputBytes, errorRegex = DEFAULT_ERROR_LEVEL_REGEX) {
    const CHUNK_SIZE = 64 * 1024;
    const chunkBuf = Buffer.alloc(CHUNK_SIZE);
    const fd = fs.openSync(filePath, 'r');
    try {
        let leftover = '';
        let lineNo = 0;
        const preWindow = []; // last `contextLines` non-emitted lines
        const out = [];
        let outBytes = 0;
        let lastEmittedLine = -1;
        let trailingRemaining = 0;
        let truncated = false;
        const pushOutput = (text) => {
            if (truncated)
                return false;
            const size = Buffer.byteLength(text, 'utf8');
            if (outBytes + size > maxOutputBytes) {
                out.push('... [truncated] ...\n');
                truncated = true;
                return false;
            }
            out.push(text);
            outBytes += size;
            return true;
        };
        const emitLine = (n, text) => {
            if (truncated || n <= lastEmittedLine)
                return;
            if (lastEmittedLine >= 0 && n - lastEmittedLine > 1) {
                const skipped = n - lastEmittedLine - 1;
                if (!pushOutput(`... [${skipped} lines skipped] ...\n`))
                    return;
            }
            if (!pushOutput(text))
                return;
            lastEmittedLine = n;
        };
        const processLine = (text) => {
            if (truncated)
                return;
            lineNo += 1;
            const isError = errorRegex.test(text);
            if (isError) {
                // Flush the pre-window first so the reader sees what led up to the error.
                const winStart = lineNo - preWindow.length;
                for (let i = 0; i < preWindow.length; i += 1) {
                    emitLine(winStart + i, preWindow[i]);
                }
                preWindow.length = 0;
                emitLine(lineNo, text);
                trailingRemaining = contextLines;
            }
            else if (trailingRemaining > 0) {
                // We're in the trailing-context window of a recent error.
                emitLine(lineNo, text);
                trailingRemaining -= 1;
            }
            else {
                // Quiet INFO/DEBUG line — keep in the rolling pre-window only.
                preWindow.push(text);
                if (preWindow.length > contextLines)
                    preWindow.shift();
            }
        };
        while (!truncated) {
            const n = fs.readSync(fd, chunkBuf, 0, CHUNK_SIZE, null);
            if (n === 0)
                break;
            const chunk = leftover + chunkBuf.subarray(0, n).toString('utf8');
            const lastNl = chunk.lastIndexOf('\n');
            if (lastNl === -1) {
                leftover = chunk;
                continue;
            }
            const completePart = chunk.slice(0, lastNl + 1);
            leftover = chunk.slice(lastNl + 1);
            // Match every "<chars>\n" line (including empty lines = "\n").
            const lines = completePart.match(/[^\n]*\n/g);
            if (lines) {
                for (const line of lines) {
                    if (truncated)
                        break;
                    processLine(line);
                }
            }
        }
        if (!truncated && leftover.length > 0) {
            // Trailing line without a final newline; treat it as a complete line so
            // an error in the very last line still gets emitted.
            processLine(leftover.endsWith('\n') ? leftover : leftover + '\n');
        }
        if (out.length === 0)
            return Buffer.alloc(0);
        return Buffer.from(out.join(''), 'utf8');
    }
    finally {
        fs.closeSync(fd);
    }
}
function listFilesRecursive(root) {
    const files = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath);
            }
            else if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    };
    visit(root);
    return files;
}
/**
 * Append an external log source to the zip.
 * Only files with `mtime >= sinceMs` are considered. Per-file content is
 * extracted using one of two modes (see `ExtraLogSource` doc):
 *
 * - error-context mode: emits a `<file>.errors` entry containing only the
 *   ERROR/WARN/FATAL lines and their surrounding context. Files with zero
 *   hits but a recent mtime fall back to a `<file>.tail` entry of the trailing
 *   `fallbackTailBytes`; old clean files are skipped entirely.
 * - plain-tail mode: emits the full file (or a `<file>.tail` entry truncated
 *   to `maxBytesPerFile`) — the legacy behaviour kept for sources that don't
 *   want line-level filtering.
 *
 * Returns the number of files actually added to the zip from this source
 * (used for logging stats). All IO errors are silently swallowed: a single
 * file failure does not affect the others, and a directory-read failure
 * skips the whole source.
 */
export function appendExtraLogSource(archive, source, sinceMs) {
    if (!fs.existsSync(source.dir)) {
        return 0;
    }
    let added = 0;
    let files;
    try {
        files = source.recursive
            ? listFilesRecursive(source.dir).map((filePath) => path.relative(source.dir, filePath).split(path.sep).join('/'))
            : fs.readdirSync(source.dir);
    }
    catch {
        return added;
    }
    const now = Date.now();
    for (const file of files) {
        if (!source.match(path.basename(file), file))
            continue;
        const filePath = path.join(source.dir, file);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile())
                continue;
            const mtime = stat.mtime.getTime();
            if (mtime < sinceMs)
                continue;
            if (source.errorContext) {
                const cfg = source.errorContext;
                const errBuf = extractErrorContext(filePath, cfg.contextLines, cfg.maxOutputBytes, cfg.errorRegex);
                if (errBuf.length > 0) {
                    archive.append(errBuf, { name: source.prefix + file + '.errors' });
                    added += 1;
                    continue;
                }
                // No ERROR/WARN/FATAL hits. Keep a tail only when the file is recent
                // enough that it might be the active session containing a silent failure.
                if (now - mtime <= cfg.fallbackRecentMs) {
                    const tailBuf = readTailWithLineAlign(filePath, stat.size, cfg.fallbackTailBytes);
                    archive.append(tailBuf, { name: source.prefix + file + '.tail' });
                    added += 1;
                }
                continue;
            }
            const cap = source.maxBytesPerFile;
            if (cap && stat.size > cap) {
                // Take the trailing `cap` bytes aligned to a line start; the `.tail`
                // suffix in the zip entry name signals to readers that this file is truncated.
                const buf = readTailWithLineAlign(filePath, stat.size, cap);
                archive.append(buf, { name: source.prefix + file + '.tail' });
            }
            else {
                archive.file(filePath, { name: source.prefix + file });
            }
            added += 1;
        }
        catch {
            continue;
        }
    }
    return added;
}
