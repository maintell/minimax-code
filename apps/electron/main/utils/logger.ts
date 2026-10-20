import { createBoundedLogStorage } from "./bounded-log-storage.js";
import path from "path";
import electronLog from "electron-log";
import { isDev } from "../config";
import { installConsoleTransportEpipeGuard } from "./console-transport-guard";
/**
 * Electron 主进程日志工具
 * 使用 electron-log 实现日志记录，按类别分文件写入
 *
 * 日志类别：
 * - update: 热更新 + 应用更新 (update-02-13.log)
 * - api: 非心跳 API 请求 (api-02-13.log)
 * - heartbeat: 心跳请求 (heartbeat-02-13.log)
 * - chat: WebSocket/消息/对话相关 (chat-{prefix}-02-13.log)
 * - imGateway: IM 网关相关（飞书、微信等）(imGateway-02-13.log)
 * - main: 其他主进程日志，默认 (main-02-13.log)
 *
 * 特性：
 * - 开发环境：终端显示彩色日志
 * - 生产环境：终端显示 + 写入日志文件（按类别和日期分割，保留 7 天）
 *
 * 日志文件位置：
 * 国内版:
 *   - macOS: ~/Library/Logs/MiniMax/
 *   - Windows: %USERPROFILE%\AppData\Roaming\MiniMax\logs\
 *   - Linux: ~/.config/MiniMax/logs/
 * 海外版:
 *   - macOS: ~/Library/Logs/MiniMax Agent/
 *   - Windows: %USERPROFILE%\AppData\Roaming\MiniMax Agent\logs\
 *   - Linux: ~/.config/MiniMax Agent/logs/
 */
// 初始化 electron-log（如果 initialize 方法存在）
if (typeof electronLog.initialize === 'function') {
    electronLog.initialize();
}
// 控制台配置 - 始终输出到终端
electronLog.transports.console.level = isDev ? 'debug' : 'info';
electronLog.transports.console.format = isDev
    ? '[{h}:{i}:{s}.{ms}] [{level}] {text}'
    : '[{y}-{m}-{d} {h}:{i}:{s}] [{level}] {text}';
installConsoleTransportEpipeGuard(electronLog.transports.console, [process.stdout, process.stderr]);
// 禁用 electron-log 默认的文件写入，改用自定义的分类文件写入
// 保留 file transport 的配置用于获取日志目录路径
electronLog.transports.file.level = false;
electronLog.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
electronLog.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
/**
 * 获取当前日期字符串 MM-DD
 */
function getDateString() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${month}-${day}`;
}
function getFullDateString() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function isComputerUseLog(category, prefix) {
    return (category === 'main' &&
        prefix !== undefined &&
        ['computer-use', 'computer-use-preview', 'computer-use-permission-guide'].includes(prefix));
}
// 默认日志文件名（main 类别）
electronLog.transports.file.fileName = `main-${getDateString()}.log`;
// 错误捕获 - 记录未捕获的异常
electronLog.errorHandler.startCatching();
/**
 * 获取日志目录路径
 */
export function getLogDir() {
    const logFile = electronLog.transports.file.getFile();
    return path.dirname(logFile.path);
}
/**
 * 获取指定类别的日志文件名
 * @param category - 日志类别
 * @param filenamePrefix - 文件名前缀（可选），用于在类别基础上进一步区分日志文件
 *   例如传入 chatId 生成 chat-12345-02-13.log
 */
function getLogFileName(category, filenamePrefix) {
    // A stable CUA filename gives each category one shared 5 MiB x 4 budget across days.
    if (isComputerUseLog(category, filenamePrefix))
        return `${category}-${filenamePrefix}.log`;
    const dateStr = category === 'remoteControl' ? getFullDateString() : getDateString();
    if (filenamePrefix) {
        return `${category}-${filenamePrefix}-${dateStr}.log`;
    }
    return `${category}-${dateStr}.log`;
}
// A shared chain serializes writes, rotation and cleanup across categories.
// Otherwise one category could prune a file while another appends to it.
const storage = createBoundedLogStorage({ isManagedFile: isManagedLogFile });
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RECORDS = 2048;
let writeChain = Promise.resolve();
let pendingCount = 0;
let pendingBytes = 0;
let droppedCount = 0;
let cleanupPromise;
let flushResolvers = [];
function finishPendingWrite() {
    pendingCount--;
    if (pendingCount === 0) {
        for (const resolve of flushResolvers)
            resolve();
        flushResolvers = [];
    }
}
function boundedRecord(content) {
    // Slice before encoding so exceptional strings do not allocate huge Buffers.
    const bytes = Buffer.from(content.slice(0, MAX_RECORD_BYTES) + '\n');
    if (bytes.length <= MAX_RECORD_BYTES)
        return bytes;
    const suffix = Buffer.from(' [truncated]\n');
    let end = MAX_RECORD_BYTES - suffix.length;
    while ((bytes[end] & 0xc0) === 0x80)
        end--;
    return Buffer.concat([bytes.subarray(0, end), suffix]);
}
function shouldWriteFileInDev(category, filenamePrefix) {
    // chat/session-trace is the historical dev allow-list entry. remoteControl
    // is added because the RC bridge is exercised mostly during dev 联调; without
    // files the WS lifecycle is hard to inspect in diagnostic bundles.
    // main/ssh-perf carries the SSH Runtime latency records, which are only
    // useful when they can be aggregated across a whole dev session.
    return ((category === 'chat' && filenamePrefix === 'session-trace') ||
        category === 'remoteControl' ||
        (category === 'archon' &&
            (filenamePrefix === 'browser-input' ||
                filenamePrefix === 'renderer-error' ||
                filenamePrefix === 'miniapp-control')) ||
        (category === 'main' &&
            (filenamePrefix === 'browser-profile-import' ||
                filenamePrefix === 'git-review-trace' ||
                filenamePrefix === 'ssh-perf' ||
                filenamePrefix === 'ssh-diagnostics' ||
                filenamePrefix === 'computer-use')));
}
/** Queue bounded, best-effort writes without blocking the main process. */
function writeToFile(category, content, filenamePrefix) {
    if (isDev && !shouldWriteFileInDev(category, filenamePrefix))
        return;
    try {
        const logDir = getLogDir();
        const filePath = path.join(logDir, getLogFileName(category, filenamePrefix));
        // Prefixes identify files, not paths. Never write outside the managed directory.
        if (path.dirname(filePath) !== logDir)
            return;
        const bytes = boundedRecord(content);
        if (pendingCount >= MAX_PENDING_RECORDS || pendingBytes + bytes.length > MAX_PENDING_BYTES) {
            droppedCount = Math.min(Number.MAX_SAFE_INTEGER, droppedCount + 1);
            return;
        }
        const policy = isComputerUseLog(category, filenamePrefix)
            ? { maxBytes: 5 * 1024 * 1024, backups: 3 }
            : category === 'main' && filenamePrefix === 'ssh-diagnostics'
                ? { maxBytes: 8 * 1024 * 1024, backups: 3, mode: 0o600 }
                : undefined;
        pendingCount++;
        pendingBytes += bytes.length;
        writeChain = writeChain
            .then(async () => {
            await storage.append(filePath, bytes, policy);
            // Summarize dropped records on the next successful queued write, even
            // if no new log arrives. flushLogs also waits for this summary.
            if (droppedCount > 0) {
                const dropped = droppedCount;
                droppedCount = 0;
                await storage.append(filePath, boundedRecord(formatLogLine('warn', `[file-logger] dropped ${dropped} records due to backpressure`)), policy);
            }
        })
            .catch(() => {
            // I/O errors must neither reject the chain nor recursively log to it.
        })
            .finally(() => {
            pendingBytes -= bytes.length;
            finishPendingWrite();
        });
    }
    catch {
        // Resolving the file transport can fail during startup/shutdown too.
    }
}
/**
 * Wait for all pending async log writes to complete.
 * Call before uploading logs or before app exit to ensure no writes are lost.
 */
export function flushLogs() {
    if (pendingCount === 0)
        return Promise.resolve();
    return new Promise((resolve) => {
        flushResolvers.push(resolve);
    });
}
/**
 * 格式化日志数据对象
 */
function formatLogData(data) {
    if (typeof data === 'string') {
        return data;
    }
    if (typeof data === 'object' && data !== null) {
        try {
            const obj = data;
            if ('msg' in obj) {
                const { msg, ...rest } = obj;
                const restStr = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
                return `${msg}${restStr}`;
            }
            return JSON.stringify(data);
        }
        catch {
            return String(data);
        }
    }
    return String(data);
}
/**
 * 格式化日志行（带时间戳和级别）
 */
function formatLogLine(level, data) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
    return `[${timestamp}] [${level}] ${formatLogData(data)}`;
}
/**
 * 创建指定类别的 logger
 * @param category - 日志类别
 * @param filenamePrefix - 文件名前缀（可选），用于在类别基础上进一步区分日志文件
 */
function createCategoryLogger(category, filenamePrefix) {
    const write = (level, data, extra) => {
        // Preserve debug file evidence in production; only the console transport
        // filters by level. Disk and queue budgets bound storage independently.
        const combined = extra === undefined ? formatLogData(data) : `${formatLogData(data)} ${formatLogData(extra)}`;
        electronLog[level](combined);
        writeToFile(category, formatLogLine(level, combined), filenamePrefix);
    };
    return {
        debug: (data, extra) => write('debug', data, extra),
        info: (data, extra) => write('info', data, extra),
        warn: (data, extra) => write('warn', data, extra),
        error: (data, extra) => write('error', data, extra),
    };
}
/**
 * Logger 接口，保持与之前 API 兼容
 * 默认写入 main 类别
 */
const logger = createCategoryLogger('main');
/**
 * 获取指定类别的 logger
 *
 * @example
 * ```ts
 * // 热更新日志
 * const updateLogger = getCategoryLogger('update');
 * updateLogger.info('[HotUpdate] checking...');
 *
 * // API 请求日志
 * const apiLogger = getCategoryLogger('api');
 * apiLogger.info('[IPC Proxy] GET /api/xxx');
 *
 * // 心跳日志
 * const heartbeatLogger = getCategoryLogger('heartbeat');
 * heartbeatLogger.info('[Heartbeat] sent');
 *
 * // 对话日志（带文件名前缀）
 * const chatLogger = getCategoryLogger('chat', '12345');
 * chatLogger.info('[WS] message received');
 * // → 写入 chat-12345-02-13.log
 * ```
 */
export function getCategoryLogger(category, filenamePrefix) {
    return createCategoryLogger(category, filenamePrefix);
}
/**
 * 获取日志文件路径（默认 main 类别）
 */
export function getLogFilePath() {
    if (isDev) {
        return '开发环境不写入日志文件';
    }
    return electronLog.transports.file.getFile().path;
}
/**
 * 匹配所有日志文件的前缀模式
 * 用于日志清理和上传时识别所有类别的日志文件
 */
export let LOG_FILE_PREFIXES = [
    'main-',
    'update-',
    'api-',
    'heartbeat-',
    'chat-',
    'imGateway-',
    'archon-',
    'remoteControl-',
    'document-preview-',
];
/**
 * 判断文件名是否为日志文件
 */
export function isLogFile(fileName) {
    return (fileName.endsWith('.log') && LOG_FILE_PREFIXES.some((prefix) => fileName.startsWith(prefix)));
}
/**
 * Re-export the external log source helpers (actual implementation lives in
 * `extra-log-source.ts`) so they can be unit-tested without pulling in the
 * import-time side effects of `electron-log`.
 */
export { resolveRuntimeLogsDir, getExtraLogSources } from "./extra-log-source";

// Legacy remoteControl archives are cleaned but not newly included in uploads.
function isManagedLogFile(fileName) {
    if (!isLogFile(fileName) && !/^remoteControl-.+\.log\.\d+\.old$/u.test(fileName))
        return false;
    if (!isDev)
        return true;
    const category = LOG_FILE_PREFIXES.find((prefix) => fileName.startsWith(prefix))?.slice(0, -1);
    if (!category)
        return false;
    const prefix = fileName
        .slice(category.length + 1)
        .replace(/(?:-\d{2}-\d{2})?(?:\.\d+)?\.log(?:\.\d+\.old)?$/u, '');
    return shouldWriteFileInDev(category, prefix);
}
/**
 * 启动时清理；写入器也在持续写入期间检查七天保留和目录容量。
 * 与追加/轮转共用串行队列，flushLogs 会等待清理完成。
 */
export function cleanupOldLogs() {
    if (cleanupPromise)
        return cleanupPromise;
    pendingCount++;
    cleanupPromise = writeChain
        .then(() => storage.cleanup(getLogDir()))
        .catch(() => {
        // Best-effort maintenance must not prevent application startup.
    })
        .finally(() => {
        cleanupPromise = undefined;
        finishPendingWrite();
    });
    writeChain = cleanupPromise;
    return cleanupPromise;
}
export default logger;
