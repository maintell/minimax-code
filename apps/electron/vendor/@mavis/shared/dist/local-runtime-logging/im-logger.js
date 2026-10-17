import { createDiskLogTransport, createStructuredLogger, wrapTraceContextLogger, } from '../logging/index.js';
/**
 * IM-subsystem logger facade.
 *
 * Mirror of `common/logger.ts` but with a physically independent pino
 * instance and disk transport so the AC audit line + all IM channel/adapter
 * chatter lands in `<dataDir>/v2/observability/logs/im-runtime-<YYYYMMDDHH>[.N].log`
 * — separate from the main `runtime-*.log` so operators can grep it, retain
 * it, and rotate it independently.
 *
 * Allowed APIs: `info`, `warn`, `error`, plus the `ctxInfo`/`ctxWarn`/`ctxError`
 * exports (re-exported through `common/index.ts` as `imCtxInfo` / `imCtxWarn`
 * / `imCtxError`). Business code (IM channels, adapters, permission-bridge,
 * host-channels wiring) imports `imLogger` from this module aliased as
 * `logger`; the AC store consumes it through the `bindAccessControlAuditLogger`
 * adapter in `channels/access-control-store.ts`.
 *
 * Persistent-disk fan-out is opt-in via {@link configureImLogger} — the host
 * wiring (Electron main, CLI `tui.ts`) calls it during boot with a `dir`,
 * which swaps the module-level base logger for one whose pretty output is
 * teed into the `im-runtime-` file family. Electron's feedback upload path
 * scans that prefix (see `apps/electron/main/utils/extra-log-source.ts`), so
 * user diagnostic bundles automatically include IM audit history.
 */
let activeDisk = null;
let baseLogger = wrapTraceContextLogger(createStructuredLogger());
/**
 * Install (or re-install) the IM-subsystem engineering logger. Idempotent:
 * the previous disk transport (if any) is detached synchronously and its
 * final flush runs in the background.
 *
 * When `opts.dir` is omitted the disk arm is disabled and the base logger
 * falls back to stdout-only — the pre-configure default. That path is
 * intended for tests / early boot before dataDir is resolved.
 */
export function configureImLogger(opts = {}) {
    const previous = activeDisk;
    activeDisk = null;
    if (opts.dir) {
        const { dir, maxBytesPerFile, maxTotalBytes, retentionMs, now, onError, loggerOptions } = opts;
        // prefix: 'im-runtime' — disk transport composes '<prefix>-<hourKey>.log',
        // i.e. 'im-runtime-2026061209.log'. Never pass 'im-runtime-' here or the
        // transport would produce a double-dashed 'im-runtime--<hour>.log'.
        const diskOpts = { dir, prefix: 'im-runtime' };
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
        // chain in the background. Any close errors were already routed through
        // its `onError` sink; we just prevent an unhandled rejection.
        void previous.close().catch(() => { });
    }
}
/**
 * Flush pending disk writes without tearing down the base logger. Called
 * by the feedback upload path before it reads the log directory.
 */
export async function flushImLogger() {
    if (!activeDisk)
        return;
    await activeDisk.flush();
}
/**
 * Close the disk transport (flush + retention sweep + stop accepting new
 * writes). Called during Electron `will-quit` / CLI graceful shutdown so
 * the final rotation sweep runs before the process exits.
 *
 * After shutdown the module-level logger keeps working (stdout only) — a
 * subsequent {@link configureImLogger} call re-installs it.
 */
export async function shutdownImLogger() {
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
export const imLogger = {
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
export function ctxInfo(ctx, fields, message) {
    baseLogger.info({ ctx, ...fields }, message);
}
export function ctxWarn(ctx, fields, message) {
    baseLogger.warn({ ctx, ...fields }, message);
}
export function ctxError(ctx, fields, message) {
    baseLogger.error({ ctx, ...fields }, message);
}
/**
 * Test-only helper mirroring `common/logger.ts`'s `__getBaseLoggerForTests`.
 * The 4 IM tests that previously spied on the main logger's baseLogger now
 * spy this one instead; shape and behaviour are identical.
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
//# sourceMappingURL=im-logger.js.map