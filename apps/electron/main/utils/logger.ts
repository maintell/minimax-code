import { isComputerUseLog, createComputerUseLogWriter } from "./computer-use-log-writer";
import promises from "fs/promises";
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
// Track whether the log directory has been ensured to avoid repeated checks.
let logDirEnsured = false;
// Per-file serial write chains — ensures writes to the same log file are ordered.
const writeComputerUseLog = createComputerUseLogWriter();
const writeChains = new Map();
// Pending write count for flush support.
let pendingCount = 0;
let flushResolvers = [];
function shouldWriteFileInDev(category, filenamePrefix) {
    // chat/session-trace is the historical dev allow-list entry. remoteControl
    // is added because the RC bridge is exercised mostly during dev 联调; without
    // files the WS lifecycle is hard to inspect in diagnostic bundles.
    return ((category === 'chat' && filenamePrefix === 'session-trace') ||
        category === 'remoteControl' ||
        (category === 'archon' &&
            (filenamePrefix === 'browser-input' ||
                filenamePrefix === 'renderer-error' ||
                filenamePrefix === 'miniapp-control')) ||
        (category === 'main' &&
            (filenamePrefix === 'browser-profile-import' ||
                filenamePrefix === 'git-review-trace' ||
                filenamePrefix === 'computer-use')));
}
/**
 * 写入日志到指定类别的文件（异步，fire-and-forget）
 * 非开发环境下，将日志异步追加写入对应类别的文件，不阻塞主进程。
 * 同一文件的写入通过 Promise chain 串行化，保证日志顺序。
 */
function writeToFile(category, content, filenamePrefix) {
    if (isDev && !shouldWriteFileInDev(category, filenamePrefix))
        return;
    const logDir = getLogDir();
    const fileName = getLogFileName(category, filenamePrefix);
    const filePath = path.join(logDir, fileName);
    const doWrite = async () => {
        if (isComputerUseLog(category, filenamePrefix)) {
            await writeComputerUseLog(filePath, content);
            return;
        }
        if (category === 'remoteControl') {
            try {
                const stat = await promises.stat(filePath);
                const maxRemoteControlLogSize = 50 * 1024 * 1024;
                if (stat.size >= maxRemoteControlLogSize) {
                    await promises.rename(filePath, `${filePath}.${Date.now()}.old`);
                }
            }
            catch {
                // file does not exist yet, or rotation failed; append best-effort below
            }
        }
        await promises.appendFile(filePath, content + '\n').catch(() => { });
    };
    // Chain this write after the previous write to the same file.
    const prev = writeChains.get(filePath) ?? Promise.resolve();
    pendingCount++;
    const next = prev
        .then(() => {
        if (!logDirEnsured) {
            return promises
                .mkdir(logDir, { recursive: true })
                .then(() => {
                logDirEnsured = true;
            })
                .catch(() => { });
        }
    })
        .then(doWrite)
        .finally(() => {
        // Clean up chain entry when it becomes the tail — avoids map growth.
        if (writeChains.get(filePath) === next) {
            writeChains.delete(filePath);
        }
        pendingCount--;
        if (pendingCount === 0 && flushResolvers.length > 0) {
            for (const resolve of flushResolvers)
                resolve();
            flushResolvers = [];
        }
    });
    writeChains.set(filePath, next);
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

/**
 * 清理过期日志文件（保留最近 7 天）
 * 应在应用启动时调用，异步执行不阻塞启动流程
 */
export async function cleanupOldLogs() {
    if (isDev)
        return;
    try {
        const logDir = getLogDir();
        let files;
        try {
            files = await promises.readdir(logDir);
        }
        catch {
            return;
        }
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 天
        for (const file of files) {
            if (isLogFile(file)) {
                const filePath = path.join(logDir, file);
                try {
                    const stat = await promises.stat(filePath);
                    if (now - stat.mtimeMs > maxAge) {
                        await promises.unlink(filePath);
                    }
                }
                catch {
                    // Skip individual file failures
                }
            }
        }
    }
    catch {
        // 静默失败，不影响日志功能
    }
}
export default logger;
