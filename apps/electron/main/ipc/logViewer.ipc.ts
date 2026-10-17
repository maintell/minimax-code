/**
 * 日志查看器 IPC 处理
 * 仅在测试环境可用
 */
import * as fsp from "fs/promises";
import * as path from "path";
import { ipcMain } from "electron";
import electronLog from "electron-log";
import { IPC_CHANNELS } from "../config/constants";
import { isTest, isStaging, isInternalBuild } from "../config/env";
import { resolveLocalRuntimeDataDir } from "../modules/local-runtime/data-dir";
import { resolveLocalRuntimeV2DirectoryContract } from "../modules/local-runtime/v2-paths";
import { createLogViewerWindow } from "../windows";
/**
 * 获取日志目录路径
 */
function getLogDirectory() {
    // electron-log 默认日志目录
    const logFile = electronLog.transports.file.getFile();
    return path.dirname(logFile.path);
}
function getRuntimeLogsDirectory() {
    return resolveLocalRuntimeV2DirectoryContract(resolveLocalRuntimeDataDir()).logs;
}
function getRuntimeEventsDirectory() {
    return resolveLocalRuntimeV2DirectoryContract(resolveLocalRuntimeDataDir()).events;
}
function isRuntimeLogFile(name) {
    return (/^local-runtime-\d{10}(?:\.\d+)?\.log$/.test(name) ||
        /^runtime-\d{10}(?:\.\d+)?\.log$/.test(name) ||
        /^im-runtime-\d{10}(?:\.\d+)?\.log$/.test(name) ||
        /^local-proxy-\d{10}(?:\.\d+)?\.jsonl$/.test(name));
}
function getLogSources() {
    const dataDir = resolveLocalRuntimeDataDir();
    return [
        { dir: getLogDirectory(), acceptFile: (name) => name.endsWith('.log') },
        { dir: getRuntimeLogsDirectory(), acceptFile: isRuntimeLogFile, recursive: true },
        { dir: path.join(dataDir, 'logs'), acceptFile: isRuntimeLogFile },
        {
            dir: getRuntimeEventsDirectory(),
            acceptFile: (name) => /^runtime-events-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name),
            recursive: true,
        },
        {
            dir: path.join(dataDir, 'logs', 'runtime-events'),
            acceptFile: (name) => /^runtime-events-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.jsonl$/.test(name),
        },
    ];
}
function isSamePath(a, b) {
    return path.relative(a, b) === '';
}
/**
 * 读取一个目录下所有匹配指定后缀的文件，并组成 `LogFileInfo`。
 * 单独抽出来是因为 LogViewer 现在有两个不同的来源目录：
 *   1) electron-log 的常规 `.log` 文件
 *   2) runtime 的 `.jsonl` 文件
 */
async function readLogFileInfos(dir, acceptExt, recursive = false) {
    let files;
    let dirRealPath;
    try {
        dirRealPath = await fsp.realpath(dir);
        files = recursive ? await listFilesRecursive(dir) : await fsp.readdir(dir);
    }
    catch {
        // 目录还没创建是常态，静默跳过。
        return [];
    }
    const infos = [];
    for (const file of files) {
        if (!acceptExt(path.basename(file)))
            continue;
        const filePath = path.join(dir, file);
        try {
            const stat = await fsp.lstat(filePath);
            if (stat.isSymbolicLink() || !stat.isFile())
                continue;
            const realPath = await fsp.realpath(filePath);
            if (!isPathInside(dirRealPath, realPath))
                continue;
            infos.push({
                name: file,
                path: filePath,
                size: stat.size,
                modifiedTime: stat.mtime.toISOString(),
            });
        }
        catch {
            // Skip files that can't be stat'd
        }
    }
    return infos;
}
async function resolveReadableLogPath(filePath) {
    const normalizedPath = path.resolve(filePath);
    const fileName = path.basename(normalizedPath);
    for (const source of getLogSources()) {
        if (!source.acceptFile(fileName))
            continue;
        let rootRealPath;
        try {
            rootRealPath = await fsp.realpath(source.dir);
        }
        catch {
            continue;
        }
        try {
            const stat = await fsp.lstat(normalizedPath);
            if (stat.isSymbolicLink() || !stat.isFile())
                continue;
            const realPath = await fsp.realpath(normalizedPath);
            if (isPathInside(rootRealPath, realPath))
                return realPath;
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * 获取所有日志文件列表
 *
 * 现在同时枚举 electron-log 目录下的 `.log` 文件和
 * runtime observability 目录 下的 `.jsonl` 文件，统一按修改时间倒序。
 */
async function getLogFiles() {
    try {
        const sourceLogs = await Promise.all(getLogSources().map((source) => readLogFileInfos(source.dir, source.acceptFile, source.recursive === true)));
        const logFiles = sourceLogs.flat();
        // 按修改时间倒序排列（最新的在前）
        logFiles.sort((a, b) => new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
        return logFiles;
    }
    catch (error) {
        console.error('[LogViewer] Failed to get log files:', error);
        return [];
    }
}
async function listFilesRecursive(root) {
    const files = [];
    const visit = async (dir, relativeDir) => {
        const entries = await fsp.readdir(dir);
        for (const name of entries) {
            const filePath = path.join(dir, name);
            const relativePath = relativeDir ? path.join(relativeDir, name) : name;
            const stat = await fsp.lstat(filePath);
            if (stat.isSymbolicLink())
                continue;
            if (stat.isDirectory()) {
                await visit(filePath, relativePath);
                continue;
            }
            if (stat.isFile())
                files.push(relativePath);
        }
    };
    await visit(root, '');
    return files;
}
function isPathInside(root, child) {
    const relative = path.relative(root, child);
    return (relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative)));
}
/**
 * CSI escape sequences (colors, cursor movement). Runtime log files written
 * before the shared disk transport started stripping ANSI still carry
 * colorized tokens for their remaining 7-day retention window; parsing the
 * stripped line keeps their level badges and messages readable.
 */
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point.
const ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(text) {
    return text.includes('\u001b') ? text.replace(ANSI_CSI_PATTERN, '') : text;
}
/** Folds pino level tokens into the LogEntry union (FATAL→error, TRACE→debug). */
const PINO_LEVEL_MAP = {
    TRACE: 'debug',
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error',
    FATAL: 'error',
};
/**
 * 解析日志行
 * 支持两种格式：
 *   1. electron-log: [2024-01-15 10:30:45.123] [info] message
 *   2. pino-pretty (runtime-* / im-runtime-*): [10:30:45.123] INFO: message
 * 不匹配任何格式时退回 info 级别的整行展示。
 */
function parseLogLine(line) {
    const clean = stripAnsi(line);
    if (!clean.trim()) {
        return null;
    }
    // 匹配格式: [日期时间] [级别] 消息
    const match = clean.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?)\] \[(\w+)\] (.*)$/);
    if (match) {
        const [, timestamp, level, message] = match;
        return {
            timestamp,
            level: level.toLowerCase(),
            message,
            raw: line,
        };
    }
    // pino-pretty 格式: [HH:MM:SS.mmm] LEVEL: 消息
    const pinoMatch = clean.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\]\s+(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*:?\s+(.*)$/);
    if (pinoMatch) {
        const [, timestamp, rawLevel, message] = pinoMatch;
        return {
            timestamp,
            level: PINO_LEVEL_MAP[rawLevel] ?? 'info',
            message,
            raw: line,
        };
    }
    // 如果不匹配标准格式，作为普通消息返回
    return {
        timestamp: '',
        level: 'info',
        message: clean,
        raw: line,
    };
}
/**
 * 把 `receivedAtMs`（UTC 毫秒）格式化成 `YYYY-MM-DD HH:MM:SS.mmm`，
 * 与 electron-log 的输出格式保持一致，避免 LogViewer 在同一个面板里
 * 出现两种时间戳风格。
 */
function formatJsonlTimestamp(epochMs) {
    const d = new Date(epochMs);
    if (Number.isNaN(d.getTime()))
        return '';
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return (`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`);
}
/**
 * 解析一条结构化 JSONL 日志。
 *
 * Sink 写出的封套：
 *   { serverName, receivedAtMs, event: <parsed JSON> }           // 正常路径
 *   { serverName, receivedAtMs, raw: <string>, parseError: true } // fallback
 *
 * 我们把它折叠成 LogEntry：
 *   - level：`parseError` 标 'warn'，其余标 'info'
 *   - message：优先序列化 `event`，没有就用 `raw`
 *   - raw：保留原始行，方便用户复制原文
 */
function parseJsonlLine(line) {
    if (!line.trim())
        return null;
    let envelope;
    try {
        envelope = JSON.parse(line);
    }
    catch {
        // 即使是 jsonl 文件，也可能因写入中断出现半行 —— 退回到行级展示。
        return {
            timestamp: '',
            level: 'warn',
            message: line,
            raw: line,
        };
    }
    const receivedAtMs = typeof envelope.receivedAtMs === 'number'
        ? envelope.receivedAtMs
        : typeof envelope.tsMs === 'number'
            ? envelope.tsMs
            : typeof envelope.ts === 'number'
                ? envelope.ts
                : NaN;
    const timestamp = Number.isFinite(receivedAtMs) ? formatJsonlTimestamp(receivedAtMs) : '';
    const isParseError = envelope.parseError === true;
    let message;
    if (typeof envelope.message === 'string') {
        const component = typeof envelope.component === 'string' ? `[${envelope.component}] ` : '';
        message = `${component}${envelope.message}`;
    }
    else if (envelope.event !== undefined) {
        try {
            message = JSON.stringify(envelope.event);
        }
        catch {
            message = String(envelope.event);
        }
    }
    else if (envelope.sample !== undefined) {
        try {
            message = JSON.stringify(envelope.sample);
        }
        catch {
            message = String(envelope.sample);
        }
    }
    else if (typeof envelope.raw === 'string') {
        message = envelope.raw;
    }
    else {
        message = line;
    }
    const rawLevel = typeof envelope.level === 'string' ? envelope.level.toLowerCase() : '';
    const level = ['debug', 'info', 'warn', 'error'].includes(rawLevel)
        ? rawLevel
        : isParseError
            ? 'warn'
            : 'info';
    return {
        timestamp,
        level,
        message,
        raw: line,
    };
}
/**
 * 读取日志文件内容
 */
async function getLogContent(filePath, maxLines = 1000) {
    try {
        const content = await fsp.readFile(filePath, 'utf-8');
        const lines = content.split('\n');
        // 取最后 maxLines 行
        const recentLines = lines.slice(-maxLines);
        const isJsonl = filePath.endsWith('.jsonl');
        const parse = isJsonl ? parseJsonlLine : parseLogLine;
        const entries = [];
        for (const line of recentLines) {
            const entry = parse(line);
            if (entry) {
                entries.push(entry);
            }
        }
        return entries;
    }
    catch (error) {
        console.error('[LogViewer] Failed to read log file:', error);
        return [];
    }
}
/**
 * 设置日志查看器 IPC 处理器
 */
export function setupLogViewerIPC() {
    // 仅在测试/预发/internal 构建环境启用
    if (!isTest && !isStaging && !isInternalBuild) {
        return;
    }
    // 打开日志查看器窗口
    ipcMain.handle(IPC_CHANNELS.LOG_VIEWER_OPEN, async () => {
        await createLogViewerWindow();
        return { success: true };
    });
    // 获取日志文件列表
    ipcMain.handle(IPC_CHANNELS.LOG_VIEWER_GET_FILES, () => {
        return getLogFiles();
    });
    // 获取日志文件内容
    ipcMain.handle(IPC_CHANNELS.LOG_VIEWER_GET_CONTENT, async (_, filePath, maxLines) => {
        const readablePath = await resolveReadableLogPath(filePath);
        if (!readablePath) {
            console.error('[LogViewer] Attempted to read file outside allowed dirs:', filePath);
            return [];
        }
        return getLogContent(readablePath, maxLines);
    });
    console.log('[LogViewer] IPC handlers registered');
}
