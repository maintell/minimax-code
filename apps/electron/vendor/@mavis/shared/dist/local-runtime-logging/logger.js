import path from 'node:path';
import { createDiskLogTransport, createSessionLogger, createSessionLogTransport, createStructuredLogger, readLogSessionId, SESSION_LOG_DIR, wrapTraceContextLogger, } from '../logging/index.js';
// Layout of the per-Session files, for readers such as diagnostic bundles.
export { isSessionLogFile, SESSION_LOG_DIR } from '../logging/index.js';
let activeDisk = null;
let activeSessionDisk = null;
let baseLogger = wrapTraceContextLogger(createStructuredLogger());
let sessionLogger = null;
/**
 * Install (or re-install) the local-runtime engineering logger. Called by
 * the host wiring during boot. Safe to call more than once — the previous
 * disk transport (if any) is detached synchronously and its final flush
 * runs in the background so the caller is not held on cold-start latency.
 *
 * When `opts.dir` is omitted the disk arm is disabled and the base logger
 * falls back to stdout-only. That path is intended for tests / CLI utilities
 * that don't own a `dataDir` yet.
 */
export function configureLocalRuntimeLogging(opts = {}) {
    const previous = activeDisk;
    const previousSession = activeSessionDisk;
    activeDisk = null;
    activeSessionDisk = null;
    sessionLogger = null;
    if (opts.dir) {
        const { dir, prefix, maxBytesPerFile, maxTotalBytes, retentionMs, now, onError, loggerOptions, } = opts;
        const diskOpts = { dir };
        if (prefix !== undefined)
            diskOpts.prefix = prefix;
        if (maxBytesPerFile !== undefined)
            diskOpts.maxBytesPerFile = maxBytesPerFile;
        if (maxTotalBytes !== undefined)
            diskOpts.maxTotalBytes = maxTotalBytes;
        if (retentionMs !== undefined)
            diskOpts.retentionMs = retentionMs;
        if (now !== undefined)
            diskOpts.now = now;
        if (onError !== undefined)
            diskOpts.onError = onError;
        const disk = createDiskLogTransport(diskOpts);
        activeDisk = disk;
        baseLogger = wrapTraceContextLogger(createStructuredLogger({ ...loggerOptions, disk }));
        // Session files use the same limits as the hourly log, counted separately.
        const sessionDiskOpts = { dir: path.join(dir, SESSION_LOG_DIR) };
        if (maxBytesPerFile !== undefined)
            sessionDiskOpts.maxBytesPerFile = maxBytesPerFile;
        if (maxTotalBytes !== undefined)
            sessionDiskOpts.maxTotalBytes = maxTotalBytes;
        if (retentionMs !== undefined)
            sessionDiskOpts.retentionMs = retentionMs;
        if (now !== undefined)
            sessionDiskOpts.now = now;
        if (onError !== undefined)
            sessionDiskOpts.onError = onError;
        const sessionDisk = createSessionLogTransport(sessionDiskOpts);
        activeSessionDisk = sessionDisk;
        sessionLogger = wrapTraceContextLogger(createSessionLogger(sessionDisk, loggerOptions));
    }
    else {
        baseLogger = wrapTraceContextLogger(createStructuredLogger(opts.loggerOptions ?? {}));
    }
    // Fire-and-forget: the previous transports keep draining their own write
    // chains in the background. Any close errors already routed through the
    // transports' `onError` sink; we just prevent an unhandled rejection.
    if (previous)
        void previous.close().catch(() => { });
    if (previousSession)
        void previousSession.close().catch(() => { });
}
/**
 * 日志已经是当场写进文件的；这里等 Session 文件的后台清理跑完，不拆掉 logger。上传日志、
 * 导出诊断包之前调用，读日志目录时不会碰上正在删的文件。
 */
export async function flushLocalRuntimeLogging() {
    await Promise.all([activeDisk?.flush(), activeSessionDisk?.flush()]);
}
/**
 * Close the disk transport (flush + retention sweep + stop accepting new
 * writes). Called during Electron `will-quit` / CLI graceful shutdown so the
 * final rotation sweep runs before the process exits.
 *
 * After shutdown the module-level logger keeps working (stdout only) — a
 * subsequent {@link configureLocalRuntimeLogging} call re-installs it.
 */
export async function shutdownLocalRuntimeLogging() {
    if (!activeDisk)
        return;
    const old = activeDisk;
    const oldSession = activeSessionDisk;
    activeDisk = null;
    activeSessionDisk = null;
    sessionLogger = null;
    // Close errors were already surfaced via onError.
    await Promise.allSettled([old.close(), oldSession?.close()]);
    baseLogger = wrapTraceContextLogger(createStructuredLogger());
}
/**
 * Permission records that name a Session go to that Session's file instead of
 * the terminal and the hourly runtime log; warnings and errors go to both.
 */
function write(level, fields, message) {
    const isPermission = message.startsWith('permission.') || message.startsWith('[permission] ');
    if (sessionLogger && isPermission && readLogSessionId(fields)) {
        sessionLogger[level](fields, message);
        if (level === 'info')
            return;
    }
    baseLogger[level](fields, message);
}
export const logger = {
    info(fields, message) {
        write('info', fields, message);
    },
    warn(fields, message) {
        write('warn', fields, message);
    },
    error(fields, message) {
        write('error', fields, message);
    },
    ctxInfo(ctx, fields, message) {
        write('info', { ctx, ...fields }, message);
    },
    ctxWarn(ctx, fields, message) {
        write('warn', { ctx, ...fields }, message);
    },
    ctxError(ctx, fields, message) {
        write('error', { ctx, ...fields }, message);
    },
};
/**
 * Test-only helper: returns the underlying pino logger so spec files can
 * assert structured calls without rebuilding the facade. Not part of the
 * package's runtime API and not re-exported from `index.ts`.
 *
 * @internal
 */
export function __getBaseLoggerForTests() {
    return baseLogger;
}
/**
 * Test-only helper: returns the active disk transport so spec files can
 * inspect rotation state / flush during assertions.
 *
 * @internal
 */
export function __getActiveDiskTransportForTests() {
    return activeDisk;
}
//# sourceMappingURL=logger.js.map