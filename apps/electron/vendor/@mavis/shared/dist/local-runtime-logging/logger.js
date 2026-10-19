import { createDiskLogTransport, createStructuredLogger, wrapTraceContextLogger, } from '../logging/index.js';
let activeDisk = null;
let baseLogger = wrapTraceContextLogger(createStructuredLogger());
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
    activeDisk = null;
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
    }
    else {
        baseLogger = wrapTraceContextLogger(createStructuredLogger(opts.loggerOptions ?? {}));
    }
    if (previous) {
        // Fire-and-forget: the previous transport keeps draining its own write
        // chain in the background. Any close errors already routed through the
        // transport's `onError` sink; we just prevent an unhandled rejection.
        void previous.close().catch(() => { });
    }
}
/**
 * Flush pending disk writes without tearing down the base logger. Callers
 * (feedback upload path, forced diagnostics dump) invoke this before reading
 * the log directory to make sure the tail of the file is on disk.
 */
export async function flushLocalRuntimeLogging() {
    if (!activeDisk)
        return;
    await activeDisk.flush();
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
    activeDisk = null;
    try {
        await old.close();
    }
    catch {
        // Already surfaced via onError.
    }
    baseLogger = wrapTraceContextLogger(createStructuredLogger());
}
export const logger = {
    info(fields, message) {
        baseLogger.info(fields, message);
    },
    warn(fields, message) {
        baseLogger.warn(fields, message);
    },
    error(fields, message) {
        baseLogger.error(fields, message);
    },
    ctxInfo(ctx, fields, message) {
        baseLogger.info({ ctx, ...fields }, message);
    },
    ctxWarn(ctx, fields, message) {
        baseLogger.warn({ ctx, ...fields }, message);
    },
    ctxError(ctx, fields, message) {
        baseLogger.error({ ctx, ...fields }, message);
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