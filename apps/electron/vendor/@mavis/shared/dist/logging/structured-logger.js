import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { redactSecretText, redactSecretValue } from './redact-log-secret.js';
import { readLogSessionId } from './session-log-transport.js';
/** Extras stay serializable the way the caller built them; an exotic payload degrades to its keys. */
function stringifyExtras(extras) {
    try {
        return JSON.stringify(extras);
    }
    catch {
        return JSON.stringify(Object.keys(extras));
    }
}
function getCallerLocation() {
    const { stack } = new Error();
    if (!stack)
        return undefined;
    const stackLines = stack.split('\n').slice(1);
    let fallback;
    for (const line of stackLines) {
        if (line.includes('structured-logger.ts') ||
            line.includes('logger.ts') ||
            line.includes('node:internal')) {
            continue;
        }
        const match = line.match(/at\s+(?:.+\s+\()?(.+):(\d+):(\d+)\)?$/);
        if (!match)
            continue;
        const rawPath = match[1]?.replace(/^file:\/\//, '');
        const lineNumber = match[2];
        if (!rawPath || !lineNumber)
            continue;
        if (rawPath.includes('/node_modules/') || rawPath.includes('/pino/'))
            continue;
        const location = `${path.basename(rawPath)}:${lineNumber}`;
        if (rawPath.includes('/packages/') || rawPath.includes('/src/'))
            return location;
        fallback = fallback ?? location;
    }
    return fallback;
}
const STANDARD_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'source', 'msg', 'traceId']);
function formatLogMessage(log, messageKey) {
    const source = log.source ?? '';
    const traceId = log.traceId;
    const msg = log[messageKey] ?? '';
    const extras = {};
    for (const key of Object.keys(log)) {
        if (!STANDARD_KEYS.has(key))
            extras[key] = log[key];
    }
    // Redact here, at the single point where a log line becomes text. Every
    // level and every output (terminal, disk, Session files) passes through it,
    // so no call site has to remember to strip credentials before logging.
    const safeExtras = redactSecretValue(extras);
    const jsonStr = Object.keys(safeExtras).length > 0 ? ` ${stringifyExtras(safeExtras)}` : '';
    const traceSuffix = traceId ? ` [${traceId}]` : '';
    return `[${String(source)}]${traceSuffix} ${redactSecretText(String(msg))}${jsonStr}\n`;
}
// Shared by the terminal/disk stream and the per-Session files so every line
// has the same format.
const PRETTY_OPTIONS = {
    translateTime: 'SYS:HH:MM:ss.l',
    ignore: 'pid,hostname',
    singleLine: true,
    hideObject: true,
    messageFormat: formatLogMessage,
};
function createPrettyStream(options) {
    return pinoPretty({
        ...PRETTY_OPTIONS,
        colorize: options?.colorize ?? false,
        destination: options?.destination ?? process.stdout,
    });
}
function createLoggerOptions(options) {
    const env = options.env ?? process.env;
    return {
        level: options.level ?? env.LOG_LEVEL ?? 'info',
        mixin() {
            const source = getCallerLocation();
            return source ? { source } : {};
        },
    };
}
export function createStructuredLogger(options = {}) {
    const env = options.env ?? process.env;
    const isDev = env.NODE_ENV !== 'production';
    const primary = options.destination ?? process.stdout;
    const destination = isolateLoggerDestination(primary, options.disk, options.diskOnly === true);
    return pino(createLoggerOptions(options), createPrettyStream({
        colorize: options.colorize ?? isDev,
        destination,
    }));
}
/**
 * Logger for per-Session files (see `./session-log-transport.ts`). Its records
 * do not go to the terminal or the hourly runtime log: each one is formatted
 * like a disk log line, without colors, and written to the file of its
 * top-level Session id. Records without a Session id are dropped, so callers
 * send only Session records here.
 *
 * 写 Session 文件失败的那一行改写到 `destination`（默认是终端），不会就这样丢掉。
 */
export function createSessionLogger(disk, options = {}) {
    const format = pinoPretty.prettyFactory({ ...PRETTY_OPTIONS, colorize: false });
    let fallback;
    const writeFallback = (line) => {
        try {
            const destination = options.destination ?? process.stdout;
            fallback ??= typeof destination === 'number' ? fdToWritable(destination) : destination;
            fallback.write(line);
        }
        catch {
            // ignore stdout / journald errors — matches pino's default behaviour
        }
    };
    return pino(createLoggerOptions(options), {
        // pino calls this synchronously with one JSON record per log call.
        write(json) {
            try {
                const record = JSON.parse(json);
                const sessionId = readLogSessionId(record);
                if (!sessionId)
                    return;
                const line = format(record);
                if (!disk.write(sessionId, line))
                    writeFallback(line);
            }
            catch {
                // Losing a log line is preferable to breaking the caller.
            }
        },
    });
}
/**
 * CSI escape sequences (SGR colors, cursor movement). Stripped from the
 * disk arm so on-disk logs stay plain text for the upload error scanner and
 * human triage, regardless of the colorize setting.
 */
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point.
const ANSI_CSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
function stripAnsi(text) {
    return text.includes('\u001b') ? text.replace(ANSI_CSI_PATTERN, '') : text;
}
/**
 * 把 pino-pretty 的生命周期监听和 `primary`（通常是 process.stdout）隔开，并在配置了 disk 时把每一行
 * 同时写进日志文件；`diskOnly` 时只写文件，写文件失败的那一行才写到 `primary`。两边出错都不往外抛：
 * 终端出错再报只会刷屏，磁盘错误已经交给 transport 的 `onError`。丢一行日志也比打断调用方好。
 *
 * 调用方传的是 pino-pretty 认的文件描述符数字时，用 `fs.createWriteStream` 转成 Writable 再写。
 */
function isolateLoggerDestination(primary, disk, diskOnly) {
    const primaryStream = typeof primary === 'number' ? fdToWritable(primary) : primary;
    return new Writable({
        autoDestroy: false,
        decodeStrings: false,
        defaultEncoding: 'utf8',
        write(chunk, _encoding, cb) {
            const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
            let onDisk = false;
            if (disk) {
                try {
                    onDisk = disk.write(stripAnsi(text));
                }
                catch {
                    // disk failures already route via disk.onError; swallow here so a
                    // broken transport can never crash the pretty stream pipeline.
                }
            }
            if (!diskOnly || !onDisk) {
                try {
                    primaryStream.write(text);
                }
                catch {
                    // ignore stdout / journald errors — matches pino's default behaviour
                }
            }
            cb();
        },
    });
}
function fdToWritable(fd) {
    return createWriteStream('', { fd, autoClose: false });
}
const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
function isContextObject(v) {
    return (v !== null &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof v.traceId === 'string');
}
export function wrapTraceContextLogger(logger) {
    return new Proxy(logger, {
        get(target, prop) {
            const val = Reflect.get(target, prop, target);
            if (typeof prop === 'string' && LOG_METHODS.has(prop) && typeof val === 'function') {
                return (firstArg, ...rest) => {
                    if (isContextObject(firstArg) && !('ctx' in firstArg)) {
                        return val.call(target, { traceId: firstArg.traceId }, ...rest);
                    }
                    if (firstArg !== null && typeof firstArg === 'object' && 'ctx' in firstArg) {
                        const { ctx, ...others } = firstArg;
                        const flat = isContextObject(ctx) ? { traceId: ctx.traceId, ...others } : { ...others };
                        return val.call(target, flat, ...rest);
                    }
                    return val.call(target, firstArg, ...rest);
                };
            }
            return typeof val === 'function' ? val.bind(target) : val;
        },
    });
}
//# sourceMappingURL=structured-logger.js.map