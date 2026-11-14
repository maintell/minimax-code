/**
 * Electron main-process heap/RSS breadcrumb.
 *
 * The 2026-11-07 hang had no usable memory trace: the main process OOM'd inside
 * V8 and the only evidence was a system CPU-resource report. One line per
 * minute gives the growth curve (and the ceiling) needed to tell a leak from a
 * spike, and a warn at 60% of `heap_size_limit` fires well before the crash.
 */
import { getHeapStatistics } from "node:v8";
import logger from "../../utils/logger";
export let MAIN_MEMORY_LOG_INTERVAL_MS = 60000;
/** Warn once the heap crosses this share of `heap_size_limit`. */
export let MAIN_MEMORY_WARN_RATIO = 0.6;
const BYTES_PER_MB = 1024 * 1024;
function toMb(bytes) {
    return (bytes / BYTES_PER_MB).toFixed(1);
}
export class MainMemoryLogger {
    constructor(options = {}) {
        this.options = options;
        this.timer = null;
    }
    start() {
        if (this.timer)
            return;
        const schedule = this.options.setInterval ?? setInterval;
        this.timer = schedule(() => this.sample(), this.options.intervalMs ?? MAIN_MEMORY_LOG_INTERVAL_MS);
        // Never hold the process open just for a diagnostic breadcrumb.
        this.timer.unref?.();
    }
    stop() {
        if (!this.timer)
            return;
        const cancel = this.options.clearInterval ?? clearInterval;
        cancel(this.timer);
        this.timer = null;
    }
    /** Emit one sample. Returns false when the reading failed (never throws). */
    sample() {
        try {
            const memory = (this.options.memoryUsage ?? process.memoryUsage)();
            const heapLimit = Math.max(1, Math.trunc((this.options.heapSizeLimit ?? (() => getHeapStatistics().heap_size_limit))()));
            const line = `[MainMemory] heap_used_mb=${toMb(memory.heapUsed)} ` +
                `heap_limit_mb=${toMb(heapLimit)} rss_mb=${toMb(memory.rss)}`;
            const sink = this.options.logger ?? logger;
            sink.info(line);
            const warnRatio = this.options.warnRatio ?? MAIN_MEMORY_WARN_RATIO;
            if (memory.heapUsed > heapLimit * warnRatio) {
                sink.warn(`[MainMemory] heap usage ${toMb(memory.heapUsed)}MB is over ` +
                    `${Math.round(warnRatio * 100)}% of the ${toMb(heapLimit)}MB heap limit`);
            }
            return true;
        }
        catch {
            // Diagnostics must never affect the main-process lifecycle.
            return false;
        }
    }
}

let activeLogger = null;
/** Start the process-wide breadcrumb. Idempotent. */
export function startMainMemoryLogging(options = {}) {
    if (activeLogger)
        return;
    activeLogger = new MainMemoryLogger(options);
    activeLogger.start();
}
/** Stop and release the process-wide breadcrumb. Idempotent. */
export function stopMainMemoryLogging() {
    activeLogger?.stop();
    activeLogger = null;
}
